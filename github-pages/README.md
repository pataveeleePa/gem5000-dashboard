# GitHub Pages Frontend

หน้า GitHub ทำหน้าที่ Login, Dashboard และเลือกไฟล์ CSV รายเดือน

## ติดตั้ง

1. แก้ `config.js`
2. ใส่ Supabase URL
3. ใส่ Supabase Publishable key
4. ใส่ Apps Script Web App URL ใน `IMPORT_APP_URL`
5. Upload ไฟล์ทั้งหมดในโฟลเดอร์นี้ไป root ของ GitHub repository
6. เปิด GitHub Pages จาก branch `main` และ folder `/(root)`

ห้ามใส่ Secret key หรือ service_role ในโฟลเดอร์นี้

อ่านขั้นตอนอัปเดตจากรุ่นก่อนที่ `docs/UPDATE_V1_1_TO_V1_2_GITHUB_IMPORT_TH.md`
