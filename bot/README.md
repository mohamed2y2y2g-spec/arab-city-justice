# تشغيل بوت وزارة العدل — سيرفر التجربة

البوت ده بيشتغل مجاناً على جهازك، لكن لازم الجهاز يفضل شغال والبوت مفتوح علشان يفضل Online.

## النطاق الآمن
- سيرفر التجربة فقط: `1569044247208923291`
- قناة القضايا: `1569054230138978415`
- قناة الاجتماعات: `1569054925122699417`
- البوت يتجاهل أي سيرفر أو قناة غير المحددين فوق.
- لا تضف البوت إلى سيرفر الإنتاج أثناء الاختبار.

## 1) تثبيت Node.js
نزّل إصدار LTS من:
https://nodejs.org/en/download

بعد التثبيت افتح PowerShell واكتب:
```powershell
node -v
npm -v
```
لازم Node يكون إصدار 20 أو أحدث.

## 2) إعداد البوت في Discord
افتح صفحة البوت مباشرة:
https://discord.com/developers/applications/1568710970522472558/bot

- من Privileged Gateway Intents فعّل **Message Content Intent**.
- لا تفعّل Administrator.
- ادّيه صلاحية View Channel وRead Message History في قناتي الاختبار فقط.
- التوكن سري جداً: حطه في ملف `.env` على جهازك فقط، وما تبعتوش لأي حد أو ترفعه على GitHub.

## 3) تجهيز متغيرات التشغيل
انسخ `.env.example` وسمّي النسخة `.env`، وبعدها املأ القيم المطلوبة:
- `DISCORD_BOT_TOKEN`: من صفحة Bot في Developer Portal.
- `WORKER_INGEST_URL`: رابط استقبال الرسائل الموجود في المثال.
- `BOT_INGEST_SECRET`: قيمة سرية عشوائية تختارها بنفسك؛ لازم تتسجل بنفس القيمة كـ Worker Secret في Cloudflare قبل تشغيل الربط.

صفحة Cloudflare:
https://dash.cloudflare.com/c07e23ca3750c802b24592640bd854c8

## 4) تشغيل البوت
من داخل مجلد `bot`:
```powershell
npm install
npm start
```
لو ظهر `Connected as ...; isolated test guild only.` يبقى اتصال Discord اشتغل.

## ملاحظات
- الربط مع الموقع لن يكتمل قبل نشر Worker endpoint وضبط `BOT_INGEST_SECRET` في Cloudflare.
- النسخة الحالية تنقل الرسائل النصية الجديدة فقط من قناتي الاختبار إلى جدول الرسائل.
- لا تنشر ملف `.env` ولا تشارك التوكن أو السر في المحادثات.
- إيقاف PowerShell أو إغلاق الجهاز يوقف البوت.
