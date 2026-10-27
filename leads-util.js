// Helpers for importing phone numbers (leads) from Google Sheets / pasted text.

export function toLatinDigits(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}

export function normPhone(raw) {
  let s = toLatinDigits(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^1[0125]\d{8}$/.test(s)) s = '0' + s; // Sheets often drops the leading zero
  if (/^201[0125]\d{8}$/.test(s)) s = '+' + s;
  return s;
}

// last 10 digits = key used to detect duplicates regardless of formatting (+20 / 0 / spaces)
export function phoneKey(p) {
  return toLatinDigits(p).replace(/\D/g, '').slice(-10);
}

export function looksLikePhone(cell) {
  const c = toLatinDigits(cell).trim();
  if (!c || !/^[+\d\s\-().]+$/.test(c)) return false;
  const digits = c.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// pasted text: one entry per line, cells separated by tab / comma / semicolon / Arabic comma
export function parsePasted(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.split(/\t|,|;|،/));
}

// rows (array of arrays) -> [{ name, phone, notes }]
// loose=true: if no cell looks like a phone, search inside the line (e.g. "أحمد 01012345678")
export function rowsToLeads(rows, loose = false) {
  const out = [];
  for (const r of rows) {
    const cells = r.map((c) => String(c ?? '').trim());
    let pi = cells.findIndex(looksLikePhone);
    if (pi !== -1) {
      const phone = normPhone(cells[pi]);
      const others = cells.filter((c, i) => i !== pi && c);
      out.push({ name: others[0] || '', notes: others.slice(1).join(' | '), phone });
      continue;
    }
    if (loose) {
      const line = toLatinDigits(cells.join(' '));
      const m = line.match(/\+?\d[\d\s\-().]{7,}\d/);
      if (m && looksLikePhone(m[0])) {
        out.push({ name: line.replace(m[0], '').replace(/\s+/g, ' ').trim(), notes: '', phone: normPhone(m[0]) });
      }
    }
  }
  return out;
}

// Google Sheet link -> direct CSV export link (sheet must be shared as "anyone with the link")
export function sheetCsvUrl(url) {
  const u = String(url || '').trim();
  if (/\/spreadsheets\/d\/e\//.test(u)) {
    // "Publish to web" link
    return /output=/.test(u) ? u : u.replace(/\/pub.*$/, '') + '/pub?output=csv';
  }
  const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
