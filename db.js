import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function defaultData() {
  return {
    users: [],
    checkins: [],
    deductions: [],
    leads: [],
    messages: [],
    settings: {
      workDays: [0, 1, 2, 3, 4], // 0=Sunday ... 6=Saturday (Fri/Sat off by default)
      lateCutoff: '10:00',
      absenceDeductionAmount: 100,
      lateDeductionAmount: 25,
    },
  };
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = defaultData();
    const adminPass = 'admin123';
    initial.users.push({
      id: crypto.randomUUID(),
      username: 'admin',
      passwordHash: bcrypt.hashSync(adminPass, 10),
      role: 'admin',
      name: 'الأدمن',
      active: true,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    console.log('\n👤 تم إنشاء حساب أدمن افتراضي:');
    console.log(`   Username: admin`);
    console.log(`   Password: ${adminPass}`);
    console.log('   (غيّر كلمة السر من صفحة الأدمن بعد أول دخول)\n');
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  const data = JSON.parse(raw);
  // backfill settings if an older db.json is missing new fields
  data.settings = { ...defaultData().settings, ...(data.settings || {}) };
  for (const key of ['users', 'checkins', 'deductions', 'leads', 'messages']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}

let db = load();

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export function getDb() {
  return db;
}

export function persist() {
  save();
}

export function newId() {
  return crypto.randomUUID();
}

export function findUserByUsername(username) {
  return db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
}

export function findUserById(id) {
  return db.users.find((u) => u.id === id);
}
