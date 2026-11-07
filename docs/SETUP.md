# إعداد بوابة وزارة العدل

## 1) قاعدة D1
قاعدة البيانات المرتبطة بالمشروع:
- الاسم: `arab-city-justice`
- Database ID: `2e78100f-a8b4-4808-a7f3-aeaf09921ee3`

من مجلد `worker` شغّل:
```bash
npx wrangler d1 execute arab-city-justice --remote --file=./schema.sql
```

## 2) إعداد Discord OAuth
في Discord Developer Portal افتح تطبيق `Arab City | Ministry Of Justice` ثم OAuth2 وأضف Redirect URL مطابقاً تماماً:
```
https://YOUR-WORKER-DOMAIN/auth/callback
```
استبدل YOUR-WORKER-DOMAIN بعنوان Worker الفعلي. لا تستخدم رابطاً مختلفاً بين إعداد Discord وCloudflare.

Scopes المطلوبة في تسجيل الدخول: `identify` و`guilds.members.read`.

## 3) أسرار Cloudflare
من Worker > Settings > Variables and Secrets أضف الأسرار التالية كـ Secrets:
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` (قيمة رابط callback أعلاه)
- `SESSION_SECRET` (قيمة عشوائية طويلة لا تقل عن 32 بايت)

لا تضع الأسرار في GitHub أو ترسلها في المحادثة.

المتغيرات غير السرية موجودة في `wrangler.toml`:
- Server ID
- Ministry role ID
- Judge role ID

## 4) الصلاحيات الحالية
- دخول بوابة الأعضاء يتطلب عضوية السيرفر ووجود رتبة `Ministery Of Justice`.
- نشر التعاميم متاح حالياً لرتبة `Minster Of Judge` فقط.
- لم تتم إضافة رتبة نائب الوزير لأن ID الخاص بها لم يتم تأكيده.
- البوت غير مطلوب لتدفق تسجيل الدخول الحالي؛ التحقق يتم عبر OAuth بصلاحية `guilds.members.read`.

## 5) اختبار قبل الإطلاق
1. اختبر حساباً لديه رتبة الوزارة.
2. اختبر حساباً داخل السيرفر بلا رتبة الوزارة؛ يجب رفض دخوله.
3. اختبر حساباً خارج السيرفر؛ يجب رفض دخوله.
4. اختبر نشر تعميم بحساب وزير العدل ثم بحساب عضو عادي.
5. لا تفتح البوابة للأعضاء قبل استكمال اختبارات الصلاحيات ومراجعة الإعدادات.

## ملاحظات المرحلة
هذه نسخة تأسيسية: لا تزال الطلبات والقضايا والاجتماعات والدردشة وسجل التدقيق وواجهة الإدارة غير مكتملة. لا تستخدمها كمنظومة تشغيل نهائية بعد.
