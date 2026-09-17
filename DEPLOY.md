# Render deploy checklist

- Repository ต้องมี `package.json`, `server.js`, `schema.sql`, `render.yaml`
- ใช้ Render Blueprint เพื่อสร้าง Web Service + PostgreSQL
- ตั้ง `ADMIN_PASSWORD` เป็นรหัสจริงของคุณ
- `JWT_SECRET` ให้ Render สร้างอัตโนมัติจาก `generateValue: true`
- ถ้าแอป iOS เรียก API จากคนละ origin ให้ตั้ง `CORS_ORIGIN` เป็นโดเมนแอป/เว็บที่ต้องการ แทน `*` เมื่อพร้อมใช้งานจริง
- Endpoint สำหรับตรวจคีย์: `POST /api/validate-key` body `{ "key": "XXXXX-XXXXX" }`
- Endpoint นี้จะ Activate คีย์ครั้งแรกและคำนวณวันหมดอายุให้ตามระยะเวลาของคีย์

## หมายเหตุเรื่องไฟล์ Patch
ไฟล์อัปโหลดถูกเก็บใน filesystem ของ Web Service ซึ่งอาจไม่ถาวรบน Render Free หาก service ถูก redeploy/recreated. ถ้าต้องการเก็บไฟล์ถาวร ให้เปลี่ยน storage เป็น object storage (เช่น S3-compatible) ในภายหลัง.
