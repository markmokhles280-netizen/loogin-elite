import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, persist, newId, findUserByUsername, findUserById } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-please';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(
    `\n❌ نسخة Node.js عندك قديمة (${process.versions.node}). المشروع محتاج نسخة 18 أو أحدث.\n` +
    `حمّل نسخة أحدث من https://nodejs.org\n`
  );
  process.exit(1);
}
if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('\n⚠️  BOT_TOKEN أو CHAT_ID مش متظبطين في .env — تسجيل الحضور هيشتغل بس من غير إرسال لتيليجرام.\n');
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 14 }, // 14 days
  })
);

// ---------- helpers ----------
function cairoDateKey(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
}
function cairoTimeHM(d = new Date()) {
  return d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour12: false, hour: '2-digit', minute: '2-digit' });
}
function weekdayOf(dateKey) {
  return new Date(dateKey + 'T00:00:00Z').getUTCDay();
}
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول' });
  const user = findUserById(req.session.userId);
  if (!user || !user.active) return res.status(401).json({ ok: false, error: 'الحساب غير متاح' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'للأدمن فقط' });
  next();
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findUserByUsername(username || '');
  if (!user || !user.active || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'اسم المستخدم أو كلمة السر غلط' });
  }
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(currentPassword || '', req.user.passwordHash)) {
    return res.status(400).json({ ok: false, error: 'كلمة السر الحالية غلط' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ ok: false, error: 'كلمة السر الجديدة قصيرة أوي' });
  }
  req.user.passwordHash = bcrypt.hashSync(newPassword, 10);
  persist();
  res.json({ ok: true });
});

// ---------- check-in ----------
app.post('/api/checkin', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const { lat, lng, accuracy, note = '', type = 'in' } = req.body;
    if (!req.file) return res.status(400).json({ ok: false, error: 'الصورة مطلوبة' });

    const now = new Date();
    const dateKey = cairoDateKey(now);
    const timeStr = now.toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });

    let locationLine = 'الموقع غير متاح';
    if (lat && lng) {
      locationLine = `📍 https://maps.google.com/?q=${lat},${lng}${accuracy ? ` (دقة ~${Math.round(accuracy)} م)` : ''}`;
    }

    const record = {
      id: newId(),
      userId: req.user.id,
      name: req.user.name,
      type: type === 'out' ? 'out' : 'in',
      dateKey,
      time: now.toISOString(),
      lat: lat ? Number(lat) : null,
      lng: lng ? Number(lng) : null,
      note,
    };
    const db = getDb();
    db.checkins.unshift(record);
    persist();

    if (BOT_TOKEN && CHAT_ID) {
      const caption =
        `👤 ${req.user.name}\n` +
        `${record.type === 'in' ? '🟢 حضور' : '🔴 انصراف'}\n` +
        `🕒 ${timeStr}\n` +
        `${locationLine}` +
        (note ? `\n📝 ${note}` : '');

      const form = new FormData();
      form.append('chat_id', CHAT_ID);
      form.append('caption', caption);
      form.append('photo', new Blob([req.file.buffer], { type: req.file.mimetype }), 'checkin.jpg');

      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
      const tgData = await tgRes.json();
      if (!tgData.ok) console.error('Telegram error:', tgData);
      else if (lat && lng) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendLocation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, latitude: Number(lat), longitude: Number(lng) }),
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'حصل خطأ في السيرفر' });
  }
});

app.get('/api/my/checkins', requireAuth, (req, res) => {
  const db = getDb();
  const mine = db.checkins.filter((c) => c.userId === req.user.id).slice(0, 30);
  res.json({ ok: true, checkins: mine });
});

// ---------- employee: deductions (own) ----------
app.get('/api/my/deductions', requireAuth, (req, res) => {
  const db = getDb();
  const mine = db.deductions.filter((d) => d.userId === req.user.id).sort((a, b) => b.date.localeCompare(a.date));
  res.json({ ok: true, deductions: mine });
});

// ---------- employee: leads (own) ----------
app.get('/api/my/leads', requireAuth, (req, res) => {
  const db = getDb();
  const mine = db.leads.filter((l) => l.assignedTo === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ok: true, leads: mine });
});

app.patch('/api/my/leads/:id', requireAuth, (req, res) => {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === req.params.id && l.assignedTo === req.user.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'الليد مش موجود' });
  const { status, notes } = req.body || {};
  if (status) lead.status = status;
  if (notes !== undefined) lead.notes = notes;
  lead.updatedAt = new Date().toISOString();
  persist();
  res.json({ ok: true, lead });
});

// ---------- messages (employee <-> admin) ----------
function threadKey(a, b) {
  return [a, b].sort().join(':');
}

app.get('/api/messages/thread', requireAuth, (req, res) => {
  const db = getDb();
  const admin = db.users.find((u) => u.role === 'admin');
  if (!admin) return res.json({ ok: true, messages: [], withUserId: null });
  const key = threadKey(req.user.id, admin.id);
  const msgs = db.messages.filter((m) => threadKey(m.fromId, m.toId) === key).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  msgs.filter((m) => m.toId === req.user.id && !m.read).forEach((m) => (m.read = true));
  persist();
  res.json({ ok: true, messages: msgs, withUserId: admin.id });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const db = getDb();
  const admin = db.users.find((u) => u.role === 'admin');
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'اكتب رسالة الأول' });
  if (!admin) return res.status(400).json({ ok: false, error: 'مفيش أدمن متاح' });
  const msg = { id: newId(), fromId: req.user.id, toId: admin.id, text: text.trim(), createdAt: new Date().toISOString(), read: false };
  db.messages.push(msg);
  persist();
  res.json({ ok: true, message: msg });
});

// ================= ADMIN =================
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

// employees
adminRouter.get('/employees', (req, res) => {
  const db = getDb();
  res.json({ ok: true, employees: db.users.filter((u) => u.role === 'employee').map(publicUser) });
});
adminRouter.post('/employees', (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ ok: false, error: 'البيانات ناقصة' });
  const db = getDb();
  if (findUserByUsername(username)) return res.status(400).json({ ok: false, error: 'اسم المستخدم مستخدم قبل كده' });
  const user = {
    id: newId(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'employee',
    name,
    active: true,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  persist();
  res.json({ ok: true, employee: publicUser(user) });
});
adminRouter.patch('/employees/:id', (req, res) => {
  const db = getDb();
  const user = db.users.find((u) => u.id === req.params.id && u.role === 'employee');
  if (!user) return res.status(404).json({ ok: false, error: 'مش موجود' });
  const { name, password, active } = req.body || {};
  if (name) user.name = name;
  if (typeof active === 'boolean') user.active = active;
  if (password) user.passwordHash = bcrypt.hashSync(password, 10);
  persist();
  res.json({ ok: true, employee: publicUser(user) });
});
adminRouter.delete('/employees/:id', (req, res) => {
  const db = getDb();
  const idx = db.users.findIndex((u) => u.id === req.params.id && u.role === 'employee');
  if (idx === -1) return res.status(404).json({ ok: false, error: 'مش موجود' });
  db.users.splice(idx, 1);
  persist();
  res.json({ ok: true });
});

// attendance
adminRouter.get('/attendance', (req, res) => {
  const db = getDb();
  const dateKey = req.query.date || cairoDateKey();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);
  const todays = db.checkins.filter((c) => c.dateKey === dateKey);
  const rows = employees.map((e) => {
    const ins = todays.filter((c) => c.userId === e.id && c.type === 'in').sort((a, b) => a.time.localeCompare(b.time));
    const outs = todays.filter((c) => c.userId === e.id && c.type === 'out').sort((a, b) => a.time.localeCompare(b.time));
    const firstIn = ins[0] || null;
    const lastOut = outs[outs.length - 1] || null;
    const cutoff = db.settings.lateCutoff;
    const isLate = firstIn ? cairoTimeHM(new Date(firstIn.time)) > cutoff : false;
    const isWorkDay = db.settings.workDays.includes(weekdayOf(dateKey));
    let status = 'present';
    if (!firstIn) status = isWorkDay ? 'absent' : 'day-off';
    else if (isLate) status = 'late';
    return {
      userId: e.id,
      name: e.name,
      firstIn: firstIn ? firstIn.time : null,
      firstInLat: firstIn ? firstIn.lat : null,
      firstInLng: firstIn ? firstIn.lng : null,
      lastOut: lastOut ? lastOut.time : null,
      lastOutLat: lastOut ? lastOut.lat : null,
      lastOutLng: lastOut ? lastOut.lng : null,
      status,
    };
  });
  res.json({ ok: true, dateKey, rows });
});

// deductions
adminRouter.get('/deductions', (req, res) => {
  const db = getDb();
  const list = [...db.deductions].sort((a, b) => b.date.localeCompare(a.date));
  const withNames = list.map((d) => ({ ...d, name: findUserById(d.userId)?.name || 'موظف محذوف' }));
  res.json({ ok: true, deductions: withNames });
});
adminRouter.post('/deductions', (req, res) => {
  const { userId, amount, reason, date } = req.body || {};
  if (!userId || !amount || !reason) return res.status(400).json({ ok: false, error: 'البيانات ناقصة' });
  const db = getDb();
  const d = {
    id: newId(),
    userId,
    amount: Number(amount),
    reason,
    date: date || cairoDateKey(),
    auto: false,
    createdAt: new Date().toISOString(),
  };
  db.deductions.push(d);
  persist();
  res.json({ ok: true, deduction: d });
});
adminRouter.delete('/deductions/:id', (req, res) => {
  const db = getDb();
  const idx = db.deductions.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'مش موجود' });
  db.deductions.splice(idx, 1);
  persist();
  res.json({ ok: true });
});
// auto-generate absence/late deductions for a given date, skipping ones already generated
adminRouter.post('/deductions/auto-generate', (req, res) => {
  const db = getDb();
  const dateKey = req.body?.date || cairoDateKey();
  if (!db.settings.workDays.includes(weekdayOf(dateKey))) {
    return res.json({ ok: true, created: 0, message: 'اليوم ده مش يوم شغل حسب الإعدادات' });
  }
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);
  const todays = db.checkins.filter((c) => c.dateKey === dateKey);
  let created = 0;
  for (const e of employees) {
    const alreadyGenerated = db.deductions.some((d) => d.userId === e.id && d.date === dateKey && d.auto);
    if (alreadyGenerated) continue;
    const ins = todays.filter((c) => c.userId === e.id && c.type === 'in').sort((a, b) => a.time.localeCompare(b.time));
    const firstIn = ins[0] || null;
    if (!firstIn) {
      db.deductions.push({
        id: newId(), userId: e.id, amount: db.settings.absenceDeductionAmount,
        reason: 'غياب بدون تسجيل حضور', date: dateKey, auto: true, createdAt: new Date().toISOString(),
      });
      created++;
    } else if (cairoTimeHM(new Date(firstIn.time)) > db.settings.lateCutoff) {
      db.deductions.push({
        id: newId(), userId: e.id, amount: db.settings.lateDeductionAmount,
        reason: `تأخير عن ${db.settings.lateCutoff}`, date: dateKey, auto: true, createdAt: new Date().toISOString(),
      });
      created++;
    }
  }
  persist();
  res.json({ ok: true, created });
});

// settings
adminRouter.get('/settings', (req, res) => {
  res.json({ ok: true, settings: getDb().settings });
});
adminRouter.patch('/settings', (req, res) => {
  const db = getDb();
  const { workDays, lateCutoff, absenceDeductionAmount, lateDeductionAmount } = req.body || {};
  if (Array.isArray(workDays)) db.settings.workDays = workDays.map(Number);
  if (lateCutoff) db.settings.lateCutoff = lateCutoff;
  if (absenceDeductionAmount !== undefined) db.settings.absenceDeductionAmount = Number(absenceDeductionAmount);
  if (lateDeductionAmount !== undefined) db.settings.lateDeductionAmount = Number(lateDeductionAmount);
  persist();
  res.json({ ok: true, settings: db.settings });
});

// leads
adminRouter.get('/leads', (req, res) => {
  const db = getDb();
  const list = [...db.leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const withNames = list.map((l) => ({ ...l, assigneeName: l.assignedTo ? findUserById(l.assignedTo)?.name || '—' : null }));
  res.json({ ok: true, leads: withNames });
});
adminRouter.post('/leads', (req, res) => {
  const { title, phone, notes } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: 'اسم الليد مطلوب' });
  const db = getDb();
  const lead = {
    id: newId(), title, phone: phone || '', notes: notes || '',
    status: 'new', assignedTo: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  db.leads.push(lead);
  persist();
  res.json({ ok: true, lead });
});
adminRouter.post('/leads/:id/assign', (req, res) => {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'مش موجود' });
  const { userId } = req.body || {};
  lead.assignedTo = userId || null;
  lead.status = userId ? 'assigned' : 'new';
  lead.updatedAt = new Date().toISOString();
  persist();
  res.json({ ok: true, lead });
});
adminRouter.patch('/leads/:id', (req, res) => {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'مش موجود' });
  const { title, phone, notes, status } = req.body || {};
  if (title) lead.title = title;
  if (phone !== undefined) lead.phone = phone;
  if (notes !== undefined) lead.notes = notes;
  if (status) lead.status = status;
  lead.updatedAt = new Date().toISOString();
  persist();
  res.json({ ok: true, lead });
});
adminRouter.delete('/leads/:id', (req, res) => {
  const db = getDb();
  const idx = db.leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'مش موجود' });
  db.leads.splice(idx, 1);
  persist();
  res.json({ ok: true });
});

// messages (admin side, per employee thread)
adminRouter.get('/messages/unread-counts', (req, res) => {
  const db = getDb();
  const counts = {};
  db.messages.filter((m) => m.toId === req.user.id && !m.read).forEach((m) => {
    counts[m.fromId] = (counts[m.fromId] || 0) + 1;
  });
  res.json({ ok: true, counts });
});
adminRouter.get('/messages/:employeeId', (req, res) => {
  const db = getDb();
  const key = threadKey(req.user.id, req.params.employeeId);
  const msgs = db.messages.filter((m) => threadKey(m.fromId, m.toId) === key).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  msgs.filter((m) => m.toId === req.user.id && !m.read).forEach((m) => (m.read = true));
  persist();
  res.json({ ok: true, messages: msgs });
});
adminRouter.post('/messages/:employeeId', (req, res) => {
  const db = getDb();
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'اكتب رسالة الأول' });
  const msg = { id: newId(), fromId: req.user.id, toId: req.params.employeeId, text: text.trim(), createdAt: new Date().toISOString(), read: false };
  db.messages.push(msg);
  persist();
  res.json({ ok: true, message: msg });
});

app.use('/api/admin', adminRouter);

// ---------- static pages ----------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error('❌ خطأ في السيرفر:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: err.message || 'خطأ غير معروف' });
});
process.on('unhandledRejection', (err) => console.error('❌ Unhandled rejection:', err));

app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
