# Source Connect — Supabase + VPS ක්‍රමය (අයිතිකරුට සරලව)

## 1. මොකක්ද කරලා තියෙන්නේ?
- **Supabase Pro** = shop එකේ "හදවත". භාණ්ඩ, stock, orders, ගෙවීම්, customer accounts, staff login, photos සියල්ල මෙතන තියෙනවා.
- **VPS** = "පිටුපස සේවකයා":
  - photo පරීක්ෂා කරනවා (ව්‍යාජ files අයින් කරනවා, phone එකේ GPS තොරතුරු මකනවා);
  - emails යවනවා;
  - **පැයෙන් පැයට backups ගන්නවා**.
- **VPS එක නැවතුණත් shop එක වැඩ කරනවා.** Customers ට order කරන්න පුළුවන්. VPS ආපහු එනකම් emails/photo වැඩ පෝලිමේ ඉන්නවා, නැති වෙන්නේ නෑ.
- **Cloudflare R2** = backups වල දෙවෙනි පිටපත. එය encrypt කරලා තියෙන්නේ. කවුරුහරි R2 එකට ඇතුළු වුණත් customer details කියවන්න බෑ.
- Website එකේ පෙනුම **වෙනස් කරලා නෑ**. දැන් live තියෙන GitHub Pages site එකට අත තියලත් නෑ.

## 2. පරීක්ෂා කරපු දේවල් (2026-11-09, test computer එකේ)
- Database / ආරක්ෂාව / ගෙවීම් / VPS worker tests: **62/62 සාර්ථකයි**.
- සැබෑ browser එකකින් shop + admin පරීක්ෂාව: **26/26 සාර්ථකයි**. මෙයට ඇතුළත්:
  - admin login එකට 6-digit code (two-step);
  - මිල වෙනස් කිරීම, photo upload කිරීම;
  - COD order එකක්;
  - PayHere sandbox ගෙවීමක්.
- Backup → R2 → **අලුත් database එකකට ආපහු දැමීම**: සාර්ථකයි.
  - ගණන්, stock, ගෙවීම් සහ ආරක්ෂක අවසර **හරියටම පරණ එකට සමානයි** කියලා පරීක්ෂා කළා.
  - වෙනස් කරපු (tamper) backup එකක් ප්‍රතික්ෂේප වුණා.
  - වැරදි key එකකින් backup එක විවෘත කරන්න බැරි වුණා.
- **වැදගත් සොයාගැනීමක්:** සාමාන්‍ය විදියට restore කළොත්, website එකට එන ඕනම කෙනෙකුට server-only functions භාවිතා කරන්න පුළුවන් වෙන දෝෂයක් drill එකෙන් හමු වුණා. එය නිවැරදි කළා. දැන් හැම restore එකකදීම ආරක්ෂක "fingerprint" එක ස්වයංක්‍රීයව සසඳනවා.

## 3. ඔබ කළ යුතු දේවල් (ඔබේ accounts වලින්, ඔබම)
1. **Supabase Pro** project එකක් හදන්න (staging). ඔබේ Supabase account එකේ two-step login on කරන්න.
2. **Cloudflare R2:**
   - bucket එකක් හදන්න;
   - ඒ bucket එකට පමණක් අවසර තියෙන token එකක් හදන්න;
   - දින 35කින් පරණ files මැකෙන rule එකක් දාන්න.
3. **VPS:** `docs/hybrid/vps-runbook.md` §1 අනුව setup කරන්න.
4. **ඔබේ offline key එක:** ඔබේ computer එකේ `age-keygen` වලින් key එකක් හදලා USB එකක සහ password manager එකේ තියාගන්න. VPS එක සම්පූර්ණයෙන් නැති වුණත් backups විවෘත කරන්න මේ key එක ඇති.
5. Email provider එකක් තෝරන්න (SMTP).

**කවදාවත් passwords, keys හෝ "service role key" chat එකේ, email එකේ හෝ GitHub එකේ දාන්න එපා.** ඒවා දාන්නේ server එකේ files වලට හෝ provider dashboard එකට විතරයි.

## 4. සෑම දිනකම / සතියකම
- **Admin → Backups පිටුව:** කොළ පාටින් "ok" තියෙන්න ඕනේ. ඒක රතු වුණොත් (backup එක පැරණියි / drill එක අසාර්ථකයි) technical සහායකයාට දැනුම් දෙන්න.
- **සෑම ඉරිදාම උදේ 3.30:** VPS එක ස්වයංක්‍රීයව restore drill එකක් කරනවා.

## 5. Live ගෙවීම්
- Live PayHere ගෙවීම් **ඔබගේ ලිඛිත අනුමැතියකින් පසුව පමණයි**. Database එකත් අනුමැතිය දුන් කෙනාගේ නම සහ වේලාව නැතිව live mode එකට යන්න ඉඩ දෙන්නේ නෑ.
- මුලින්ම staging එකේ sandbox ගෙවීම් සම්පූර්ණයෙන් පරීක්ෂා කරන්න (`go-live-checklist.md`).

## 6. විකුණුම් සහ ලාභය (Admin → Sales & Profit)
- **දවසක් / සතියක් / මාසයක් තෝරන්න** (Today, Yesterday, Last 7 days, This month…). දින ගණන් කරන්නේ ශ්‍රී ලංකා වේලාවෙන්.
- පිටුවේ පෙන්වන දේවල්:
  - orders ගණන;
  - විකුණුණු භාණ්ඩ ගණන;
  - **විකුණුම් වටිනාකම** (promo code අඩු කළාට පස්සේ);
  - **ලැබුණු මුදල**;
  - තවම ලැබෙන්න තියෙන මුදල (COD / bank transfer);
  - භාණ්ඩ වල **පිරිවැය**, **ලාභය** සහ ලාභ ප්‍රතිශතය.
- **Best sellers:** වැඩියෙන්ම විකුණුණු භාණ්ඩ 10.
- **Sold least:** අඩුවෙන්ම විකුණුණු (හෝ කොහෙත්ම නොවිකුණුණු) භාණ්ඩ.
- **Day by day:** හැම දවසකම විකුණුම්, ලාභය සහ ඒ දවසේ වැඩියෙන්ම විකුණුණු භාණ්ඩය.
- **Download** බොත්තමෙන් Excel එකේ විවෘත කරන්න පුළුවන් file එකක් ලැබෙනවා.

**ලාභය නිවැරදි වෙන්න නම් "Cost prices" tab එකේ හැම භාණ්ඩයකටම පිරිවැය (එක භාණ්ඩයක් ඔබට වැය වෙන මුදල) දාන්න.**
- පිරිවැය දාලා නැති භාණ්ඩයක් විකුණුණොත්, ලාභය "—" ලෙස පෙන්වනවා. කොපමණ භාණ්ඩ ගණනකට පිරිවැය නැද්ද කියලත් කියනවා. **වැරදි ලාභයක් කවදාවත් පෙන්වන්නේ නෑ.**
- පළමු වතාවට පිරිවැය දානකොට "also use this cost for earlier sales" tick කළොත්, ඒ පිරිවැය කලින් විකුණුම් වලටත් යොදනවා. කලින් ගණන් කරපු පිරිවැයක් වෙනස් කරන්නේ නෑ.
- පස්සේ පිරිවැය වෙනස් කළත් **කලින් විකුණුම් වල ලාභය වෙනස් වෙන්නේ නෑ**. හැම විකුණුමක්ම විකුණපු දවසේ පිරිවැය මතක තියාගන්නවා.
- පිරිවැය රහසිගතයි. Customers ට හෝ වෙනත් staff ට පෙනෙන්නේ නෑ. බලන්න පුළුවන් owner සහ finance ට විතරයි. වෙනස් කරන්න පුළුවන් owner ට විතරයි.
- ලාභයට shipping ගාස්තු, PayHere ගාස්තු සහ courier වියදම් ඇතුළත් නෑ.

## 7. Renewals (Admin → Renewals)
- Supabase Pro, VPS, domain වගේ මුදල් ගෙවන service එකක් renew වෙන දිනයක් හෝ free trial එකක් ඉවර වෙන දිනයක් මෙතන දාන්න. **+ Add reminder** → නම, දිනය, Repeats (Every month / Every year / One time), "Warn me this many days before" (සාමාන්‍යයෙන් 1).
- දිනයට දවස් N කට කලින් සිට ඒ දවස දක්වා **admin එකේ හැම පිටුවකම උඩින්** තැඹිලි පාට warning එකක් පෙනෙනවා. Menu එකේ "Renewals" ළඟ ගණනකුත් පෙනෙනවා.
- Every month / Every year: දිනය පහු වුණාම ඊළඟ මාසයට / අවුරුද්දට තනියම යනවා (Supabase වගේ card එකෙන් auto ගෙවන නිසා).
- One time: දිනය පහු වුණාම, ඔබ වෙනස් කරනකම් හෝ මකනකම් රතු පාටින් **Overdue** කියලා පෙන්වනවා.
- දින ගණන් කරන්නේ ශ්‍රී ලංකා වේලාවෙන්. Owner ට විතරයි මේක පෙනෙන්නේ.
- දැනට warning එක පෙන්වන්නේ admin එකේ විතරයි. Email provider එකක් සෙට් කළාට පස්සේ (go-live checklist), email එකකුත් එවන්න හදන්න පුළුවන්.

## 8. Admin PIN (phone app code එක වෙනුවට)
- Admin → **Staff & Roles** → ඔබේ නම ළඟ **Set PIN** → අංක 4–8ක PIN එකක් දෙපාරක් ගහලා **Save PIN**. ඊට පස්සේ **Second sign-in step** එකේ **Admin PIN** තෝරලා **Save**.
- දැන් login වෙද්දී password එකට පස්සේ PIN එක අහනවා (QR / app එක ඕනේ නෑ). PIN එක check කරන්නේ database එකේ.
- වෙන කෙනෙක්ට admin එක පෙන්නන්න ඕනේ නම්: **+ Add staff** (සුදුසු role එක, උදා: Catalog Editor) → ඒ කෙනාට **Set PIN**. Owner ගේ password/PIN දෙන්න එපා.
- වැරදි PIN 5ක් ගැහුවොත් විනාඩි 15ක් lock වෙනවා. `1234`, `0000` වගේ ලේසි PIN බාර ගන්නේ නෑ. PIN එක hash කරලා විතරයි save කරන්නේ, කාටවත් ආපහු කියවන්න බෑ. Audit Log එකේ හැම PIN වෙනසක්ම, හරි/වැරදි උත්සාහයක්ම තියෙනවා.
- PIN එක එක login එකකට පැය 12ක් වලංගුයි. Logout කළොත් හෝ වෙන browser එකකින් ආවොත් ආයෙත් අහනවා.
- **Live යන්න කලින්** (card ගෙවීම් on කරන්න කලින්) **Authenticator app** එකට ආපහු මාරු කරන්න. ඒක තමයි වඩාම ආරක්ෂිත.

## 9. Poster banners (අකුරු එක්කම හදපු banner පින්තූර)
- Admin → **Promo Banners** → **+ Add Banner** → **Banner type** එකේ **Poster** තෝරන්න → **Poster picture** එකට පින්තූරය දාන්න → **Short description** (උදා: `11:11 Special Offer`) → **Opens** (උදා: `#flash`) → **Save**.
- Website එකේ globe එකට යටින් සම්පූර්ණ පළලින්, **පින්තූරය මුළුමනින්ම, එහි හැඩයෙන්ම** (කපන්නේ නෑ, ඇදෙන්නේ නෑ) පෙන්වනවා. Poster කිහිපයක් තියෙනවා නම් තත්පර 6කට වරක් මාරු වෙනවා; phone එකේ swipe කරන්නත් පුළුවන්.
- හොඳම ප්‍රමාණ: **1920 × 1080** (16:9) හෝ තුනී strip එකක් නම් **1920 × 600**. ඕනෑම හැඩයක් හරියට fit වෙනවා. වැදගත් අකුරු පින්තූරයේ කෙළවරටම දාන්න එපා.
- Upload කරද්දී පින්තූරය 1920px වෙනකම් තියාගන්නවා, ඒ නිසා අකුරු පැහැදිලියි. පොඩි පින්තූරයක් ලොකු කරන්නේ නෑ.
- පරණ විදියේ banners (website එක අකුරු ලියන ඒවා) වෙනසක් නැතුව තියෙනවා.

## Main admin saha Co-admin

- **Main admin** (role: Owner) — siyalu dewal karanna puluwan. Staff accounts hadanne, access approve karanne main admin witharai.
- **Co-admin** (role: Co-Admin (store)) — store eka karana aya. Karanna puluwan dewal witharai: Sales & Profit, cost prices, products (adum) saha ewaye pinthura, stock, banners, homepage, flash sale offers, promo codes.
- Co-admin ta thawa deyak ona nam (udaharanayak: orders balanna), admin eke **My Access → Request access** obanawa.
- Ita passe main admin eka **Staff & Roles → Access requests** eken eka **Approve** hari **Decline** hari karanawa.
- Main admin ta **Staff & Roles → Edit → Extra access** eken kelinma access denna puluwan. Ona welawaka tick eka ain karala aye ganna puluwan.
- "Staff & Roles" (anith ayata access denna) kisi dawasaka co-admin kenekta denna bæ. Me sima eka hadala thiyenne database eke — e nisa browser eken maga harinna bæ.
- Aluth kenek hadanna: **Staff & Roles → + Add staff** →
  - **Full name** (account eka use karana kenage nama),
  - **Username** (log wenna),
  - **Password** (akuru + ankath, akuru 12+),
  - **Role** (default **Co-Admin (store)**),
  - **Verify with**: **PIN** (ankath 4–8, dekaparak) hari **Authenticator app**.
  Email ona nê. E kena log wenne username + password eken, ita passe PIN eka hari app code eka hari. Palamu login eke password eka wenas karanna kiyanawa.
- Username eka wenas karanna (oyage ma eka ath ulathwa): **Staff & Roles → Edit → Username** → **Save**. Email nathi account ekak nam e kena eeta passe log wenne aluth username eken. Email ekak thiyena account ekak (udaharanayak main admin) log wenne kalin widiyatama e email eken. Wena kenek use karana username ekak denna bæ.
- Ekama kenekuge verify krama eka passe wenas karanna: **Edit → Verify with**. Oyage ma account eke lock wenna puluwan wenas kirima system eka nawaththanawa.

## Product reviews (stars + customer opinion)
- Review karanna puluwan **order eka deliver una customer ta witharai** (ethakota hæma review ekakma "Verified purchase"). Order eka Admin eke **Delivered** kalama, customer ge order page eke **Rate your items** kotasa penawa: stars 1–5 saha kæmathi nam opinion ekak.
  - Account ekak thiyena customer: **My account → My orders → ★ Rate & review**.
  - Guest widiyata order karapu customer: order eka karapu phone/computer eke "Orders placed on this device" eken.
- Eka order ekaka eka product ekakata review ekai. Customer ta eka passe wenas karanna puluwan. Links (www…, .com) danna denne nê.
- Website eke penne **"Nimal P."** wage kota nama witharai. Sampurna nama, phone number, address, order number penne nê.
- Product page eke **Ratings** tab eke average eka, 5★…1★ ganan (click karala filter karanna puluwan) saha aluthma reviews pennanawa.
- **Admin → Reviews** (main admin, co-admin, ops manager, support):
  - **1–2 stars**, **Not answered**, **Hidden** walin filter karanna.
  - **Reply**: oyage reply eka review eka yatin "Response from Source Connect" kiyala penawa.
  - **Hide from the website**: abusive, topic ekata adala nathi, nathnam kenekuge private details thiyena review witharak hide karanna. Negative kiyala hide karanna epa; polite reply ekak denna. Hide kalama e review eka average eken ain wenawa. Customer eka edit kalath hide wela thiyena eka hide wela ma thiyenawa.

## Customer accounts (email nathuwa)
- Account ekak hadaddi **email confirmation mail ekak yawanne nê**. Account eka ehemama hædila customer log wenawa.
- Sign-up form eke thiyenne: **Full name, Email, Phone number, Other phone (optional), Address, City, District, Password (akuru 8+)** saha kæmathi nam **Profile photo** ekak.
  - Photo eka JPEG, PNG hari WebP wenna ona, **2 MB** wenakan. Eeta wada loku nam eka ehema thiyena size ekath ekkama kiyala nawaththanawa. Upload karanna kalin photo eka podi karanawa (512 px), e nisa ikmanata load wenawa.
  - Photo eka customer ge reviews langa penawa. **My account → My details** eken wenas karanna hari ain karanna hari puluwan.
- Email yawanne nathi nisa "Forgot password" link eka nê. Ehema welawata page eke kiyanawa shop ekata call/WhatsApp karanna kiyala:
  - **Admin → Customers → Registered accounts → Set new password** (main admin saha ops manager).
  - Mulinma e kenage account eke phone number ekata call karala ehe kenamada kiyala check karanna. Ita passe aluth password eka e kenata kiyanna.
  - Hæma reset ekakma Audit Log eke record wenawa.
- **Registered accounts** list eke penawa: name, email, phones dekama, address, photo, orders ganana saha join una dawasa.

## Stars saha reviews
- Hæma product card ekakma yatin stars penawa (Flash Sale cards walath). Review nathi product ekaka stars alu paatin (0) penawa.
- Product page eke yatin **Ratings & Reviews** kotasa hæmathissema penawa: average eka, 5★…1★ ganan, aluthma reviews, customer ge photo, "Verified purchase" saha oyage reply eka.
- **My account → My orders** eke deliver una order ekaka **★ Rate & review** obanna. Ethanin stars saha comment eka danna puluwan, wena page ekakata yanna ona nê.

## Return / Refund
- **Customer:** order eka **Delivered** kalata passe **dawas 7k athulatha** (**Store Settings → return days**), **My account → My orders → ↩ Return / Refund** (guest kenek nam order eka karapu phone eke order page eken):
  - return karana items saha ganana (gaththa ganata wada denna bæ),
  - hethuwa: Arrived damaged / Does not work / Wrong item / Different from description / Parts missing ("change of mind" ganan ganne nê),
  - wisthara (akuru 10+),
  - **Money back** da **Replacement** da,
  - Cash on Delivery hari bank transfer hari nam salli danna ona **bank account** eka. Card eken gewwa nam salli aye yanne card ekatama.
  - Photos 3k wenakan (JPEG/PNG/WebP, 2 MB bagin). Photos private, staff ta witharai penne.
- Customer ta thamange request eke status eka, oyage message eka saha refund eka order eke penawa. "Waiting" status eke thiyeddi request eka withdraw karanna puluwan.
- **Admin → Returns** (main admin, ops manager, support, finance). Menu eke ganana kiyanne uththara nodunna requests:
  1. **Approve**, nathnam **Reject** (customer ta hethuwa liyanna ona).
  2. Item eka ganna → **Item received**. Aye wikunanna puluwan nam "Put the items back in stock" tick karanna.
  3. **Replacement sent**, nathnam **Record refund**: mulinma salli aye gewanna (bank transfer / PayHere portal), ita passe amount eka saha reference eka danna.
     - Me step eka karanna puluwan main admin ta saha finance ta witharai.
     - Cash on Delivery order ekaka mulinma salli labuna kiyala record karala thiyenna ona.
     - Order eke total ekata wada refund karanna bæ.
     - Mulu order ekama refund kalama order eka "Refunded" wenawa.
- Hæma step ekakma Audit Log eke saha order history eke record wenawa.

## Security (2026-11-22 karapu wenas saha oya karanna ona dewal)
- **Karala iwarai:**
  - Website eka **publishable key** eken saha server functions **secret key** eken wada karanawa. Parana `anon` / `service_role` keys **off** karala.
  - Parana HS256 JWT secret eka **revoke** kala. Dæn login tokens sign karanne extract karanna bæri ES256 key eken.
  - Strict **Content-Security-Policy** eka dæmma.
  - XSS attack test eka hama deployment ekakatama run wenawa.
- **Oya karanna ona dewal:**
  1. **Staff second step → Authenticator app:**
     - Admin → Staff & Roles → Second sign-in step → Authenticator app → Save.
     - Oyage account eke dæntath app eka thiyenawa.
     - Co-admin ta: Edit → Verify with → Authenticator app.
  2. **Database:** Supabase → Project Settings → Database:
     - **Enforce SSL** on karanna.
     - **Network Restrictions** eke direct connections nawaththanna. VPS eka hæduwama eke IP eka witharak allow karanna.
  3. **CAPTCHA (Cloudflare Turnstile):**
     - Cloudflare → Turnstile → Add widget → domain `source-connect-915.pages.dev` (passe oyage domain ekath) → mode **Managed**.
     - **Site key** eka mata denna. Eka public, chat ekata danna puluwan. Mama eka website ekata dala deploy karannam.
     - Ita passe **witharak**: Supabase → Authentication → Attack Protection → Enable CAPTCHA → Turnstile → **Secret key** eka ehe danna.
     - Secret key eka chat ekata danna epa. Ordera wenas kaloth login wenna bæri wenawa.
  4. Oyage **Supabase, Cloudflare, GitHub accounts** wala two-step login on karanna.
