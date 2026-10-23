# YuzCall — iPhone uchun video qo‘ng‘iroq (React Native + Expo)

```
face/
├── app/      Expo SDK 57 ilova (iOS)
└── server/   Signaling server (Node + WebSocket) + /privacy sahifasi
```

## Qanday ishlaydi

- **Video/ovoz P2P** (WebRTC): media server orqali o‘tmaydi → kechikish minimal, server arzon.
- **H.264 apparat kodek** (iPhone chipida) → telefon qizimaydi, batareya kam ketadi.
- **`maintain-framerate`**: internet yomonlashsa, kadrlar soni emas, sifat pasayadi → video qotmaydi.
- **720p30, 2 Mbit/s gacha**, `max-bundle`, ICE oldindan yig‘iladi (qo‘ng‘iroq jiringlayotganda) → tez ulanish.
- **Wi‑Fi ↔ LTE almashganda** avtomatik ICE restart, 30 soniya ichida tiklanmasa tugaydi.
- **Picture-in-Picture**: ilovadan chiqsangiz suhbatdosh videosi kichik oynada qoladi.
- Sozlamalardagi ID: har bir qurilmaga tasodifiy 6 xonali ID beriladi; ID orqali qo‘ng‘iroq qilinadi.

---

## 1. Serverni ishga tushirish (15 daqiqa)

### Lokal sinov
```bash
cd server && npm install && npm start      # ws://localhost:8080
npm test                                   # protokol testi
```

### Production — Render.com (tavsiya)
1. `server/` papkani GitHub’ga yuklang.
2. Render → **New → Blueprint** → repo’ni tanlang (`render.yaml` avtomatik o‘qiladi).
   Plan: **Starter** (bepul plan 15 daqiqada uxlab qoladi — qo‘ng‘iroq ilovasi uchun yaramaydi).
3. Manzil: `https://yuzcall-signaling.onrender.com` — boshqa nom chiqsa, `app/eas.json` dagi URL’larni almashtiring.
4. Tekshirish: `https://.../health` → `{"ok":true}`, `https://.../privacy` → maxfiylik sahifasi.

### TURN server (MUHIM — busiz ~15–20% qo‘ng‘iroqlar ulanmaydi)
Mobil operatorlar (Beeline, Ucell, Uzmobile…) ko‘pincha simmetrik NAT ishlatadi; bunda P2P ulanish uchun TURN kerak.
Eng oson: **Cloudflare Realtime TURN** (oyiga 1000 GB bepul):
1. Cloudflare Dashboard → Realtime → TURN → **Create key**.
2. Render’da env: `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`.

Muqobil: o‘z coturn’ingiz (`TURN_URLS` + `TURN_SECRET`) yoki Metered/Twilio (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`).

---

## 2. Ilovani telefonda sinash

Kamera simulyatorda ishlamaydi — **haqiqiy iPhone** kerak (ikkita qurilma bilan sinang).

> ⚠️ Loyiha `~/Desktop` da turibdi. Agar Desktop iCloud bilan sinxronlansa, lokal Xcode build
> `resource fork, Finder information, or similar detritus not allowed` xatosini beradi.
> Yechim: loyihani iCloud’dan tashqariga ko‘chiring (masalan `~/Projects/face`). EAS (bulut) build’ga bu ta’sir qilmaydi.

```bash
cd app
# .env ichidagi IP’ni Mac’ingizning Wi‑Fi IP’siga o‘zgartiring (ipconfig getifaddr en0)
npx expo run:ios --device
```
yoki bulutda: `npx eas-cli@latest build --profile development --platform ios`

---

## 3. App Store’ga chiqarish

```bash
cd app
npx eas-cli@latest login
npx eas-cli@latest init                 # EAS loyihasini bog‘laydi
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios --latest
```

Oldindan:
- `app.json` → `ios.bundleIdentifier` (`uz.yuzcall.app`) — o‘zingiznikiga almashtiring, App Store Connect’dagi bilan bir xil bo‘lsin.
- Ilova nomi `YuzCall` — App Store’da band bo‘lsa, `app.json` → `name` ni o‘zgartiring.

### App Store Connect’da to‘ldirish kerak
| Maydon | Qiymat |
|---|---|
| Privacy Policy URL | `https://yuzcall-signaling.onrender.com/privacy` |
| App Privacy | “Data Not Collected” (biz hech narsa yig‘maymiz) |
| Kategoriya | Social Networking |
| Skrinshotlar | 6.9" (iPhone 16 Pro Max) — kamida 3 ta |
| Export compliance | Avtomatik (`ITSAppUsesNonExemptEncryption = false`) |

### App Review uchun izoh (Notes) — buni albatta yozing
Reviewer’da ikkinchi telefon yo‘q, shuning uchun:
> “To test a call, open the app and call our always-online demo device, ID **XXX XXX**. It auto-answers.
> Alternatively, install the app on two devices and call one device’s ID from the other.”

Buning uchun alohida iPhone’da ilovani oching, pastdagi **“Avtomatik javob berish”** ni yoqing,
zaryadga ulab, ekranni o‘chirmasdan qoldiring (Sozlamalar → Displey → Auto-Lock: Never) va ID’sini yuqoridagi izohga yozing.
Aks holda review “funksiyani sinab bo‘lmadi” (2.1) deb qaytarishi mumkin.

---

## Hozirgi cheklovlar (v1.1 uchun reja)

1. **Ilova yopiq bo‘lsa qo‘ng‘iroq kelmaydi.** FaceTime kabi qulflangan ekranda jiringlash uchun
   **CallKit + PushKit (VoIP push)** kerak: Apple Developer’da VoIP sertifikat + serverdan APNs yuborish.
   Bu 1–2 kunlik ish; v1 da qo‘ng‘iroq faqat ikkala ilova ochiq bo‘lganda keladi.
2. Faqat 1:1 qo‘ng‘iroq (guruh yo‘q).
3. Kontaktlar — telefon raqam o‘rniga 6 xonali ID.
