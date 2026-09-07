# Đưa HungBot lên mạng

Ba việc, làm theo đúng thứ tự. Tổng thời gian khoảng 10–15 phút.

---

## Việc 1 — Đẩy mã nguồn lên GitHub

**Bước 1.** Vào https://github.com/new, đặt tên kho là `hungbot`, chọn **Public**,
và **KHÔNG** tích ô "Add a README file".

**Bước 2.** Mở terminal, chạy (thay `<tên-github>` bằng tên GitHub của anh):

```bash
cd "K:/May tinh chay/HungBot"
git remote add origin https://github.com/<tên-github>/hungbot.git
git push -u origin master
```

> Lần đầu GitHub sẽ hỏi đăng nhập. Nếu hỏi mật khẩu mà nhập thường không được,
> vào https://github.com/settings/tokens tạo "Personal access token (classic)",
> tích quyền `repo`, rồi dán token đó vào ô mật khẩu.

> **An toàn**: file `data/config.json` (chứa token Facebook & API key) đã được
> chặn trong `.gitignore`, không bị đẩy lên.

---

## Việc 2 — Deploy lên Railway (Node.js miễn phí)

Railway cho chạy Node.js 24/7, có URL public để Facebook gửi webhook.

**Bước 1.** Vào https://railway.app → **Login with GitHub**

**Bước 2.** Bấm **New Project** → **Deploy from GitHub repo** → chọn repo **hungbot**

**Bước 3.** Railway tự detect Node.js, chạy `npm start`. Chờ 1–2 phút để build xong.

**Bước 4.** Tạo URL public:
- Vào tab **Settings** của service
- Mục **Networking** → bấm **Generate Domain**
- Railway cho anh 1 URL dạng: `hungbot-xxx.up.railway.app`

**Bước 5.** (Tuỳ chọn) Thêm biến môi trường:
- Tab **Variables** → thêm:
  - `VERIFY_TOKEN` = `hungbot_verify_2024` (hoặc đổi thành chuỗi bí mật hơn)
  - `PORT` = `3700` (Railway tự set, nhưng thêm cho chắc)

> **Ghi lại URL Railway** — bước tiếp theo cần dùng.

---

## Việc 3 — Kết nối Facebook Webhook

Để Facebook gửi tin nhắn khách hàng tới HungBot, cần cấu hình webhook.

**Bước 1.** Vào https://developers.facebook.com → chọn app **HMONG 4S Chatbot**

**Bước 2.** Sidebar trái → **Webhooks** (hoặc **Messenger** → **Settings** → mục Webhooks)

**Bước 3.** Bấm **Edit Callback URL**:
- **Callback URL**: `https://hungbot-xxx.up.railway.app/webhook`
  (thay `hungbot-xxx` bằng URL Railway thật)
- **Verify Token**: `hungbot_verify_2024`
- Bấm **Verify and Save**

**Bước 4.** Subscribe events — tích chọn:
- ✅ `messages`
- ✅ `messaging_postbacks`

**Bước 5.** Kết nối Page:
- Mở `https://hungbot-xxx.up.railway.app` trên trình duyệt
- Vào **Settings** → đăng nhập Facebook → kết nối Page muốn auto-reply
- Vào **AI Agent** → nhập API key (OpenAI hoặc Anthropic) nếu muốn AI trả lời

---

## Xong!

Khách nhắn tin vào Page → Facebook gửi webhook → HungBot kiểm tra rule →
nếu match thì trả lời tự động, không match thì AI trả lời (nếu đã cấu hình).

### Kiểm tra nhanh

1. Mở Messenger, nhắn "xin chao" vào Page đã kết nối
2. Nếu bot trả lời → thành công!
3. Nếu không trả lời → kiểm tra:
   - Railway có đang chạy không? (tab **Deployments** phải xanh)
   - Webhook verify thành công chưa? (Facebook hiện dấu ✅)
   - Page đã kết nối trong HungBot Settings chưa?

### Chi phí

- **Railway**: miễn phí $5/tháng (trial). Đủ chạy chatbot nhỏ.
  Sau trial: ~$5/tháng cho server nhỏ.
- **Facebook API**: miễn phí.
- **OpenAI API** (nếu dùng AI): trả theo dùng, ~$0.15/1000 tin nhắn với gpt-4o-mini.
