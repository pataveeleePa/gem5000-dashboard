// คัดลอกไฟล์นี้เป็น config.js แล้วใส่ค่าจาก Supabase Project Settings > API Keys
// Publishable key สามารถใช้ในหน้าเว็บได้เมื่อเปิด RLS ตามไฟล์ SQL ในแพ็กเกจ
// ห้ามใส่ sb_secret_... หรือ service_role ในไฟล์นี้เด็ดขาด
window.GEM5000_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_REPLACE_ME',

  // URL Apps Script Web App ที่ลงท้ายด้วย /exec สำหรับรับไฟล์จากหน้า GitHub Dashboard
  IMPORT_APP_URL: ''
};
