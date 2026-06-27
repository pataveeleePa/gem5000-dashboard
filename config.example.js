// คัดลอกไฟล์นี้เป็น config.js แล้วใส่ค่าจาก Supabase Project Settings > API Keys
// Publishable key สามารถใช้ในหน้าเว็บได้เมื่อเปิด RLS ตามไฟล์ SQL ในแพ็กเกจ
// ห้ามใส่ sb_secret_... หรือ service_role ในไฟล์นี้เด็ดขาด
window.GEM5000_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_REPLACE_ME',

  // ไม่บังคับ: ลิงก์ไป Google Sheet หรือ Apps Script Import UI ที่จำกัดสิทธิ์แล้ว
  IMPORT_APP_URL: ''
};
