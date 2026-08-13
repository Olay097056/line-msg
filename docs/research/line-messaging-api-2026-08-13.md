# LINE Messaging API research — push + quota + group ID

Date: 2026-08-13  
Wayfinder: `.scratch/line-msg-v2/issues/01-line-messaging-api.md`

## Sources used

Primary sources only:

- LINE Messaging API reference: <https://developers.line.biz/en/reference/messaging-api/>
  - Raw markdown mirror fetched from official docs link: <https://github.com/line/line-developers-docs-source/blob/main/docs/en/reference/messaging-api/index.html.md>
  - Local raw fetch used for grep evidence: `.scratch/line-msg-v2/_fetch/raw/index.html.md`
- LINE Messaging API pricing: <https://developers.line.biz/en/docs/messaging-api/pricing/>
  - Local markdown fetch used for grep evidence: `.scratch/line-msg-v2/_fetch/raw/pricing-index.html.md`

## Findings

### 1. Push message endpoint for group delivery

Use:

```http
POST https://api.line.me/v2/bot/message/push
Authorization: Bearer {channel access token}
Content-Type: application/json
```

Official quote:

> `Endpoint: POST https://api.line.me/v2/bot/message/push`  
> `Sends a message to a user, group chat, or multi-person chat at any time.`

For this project, the `to` value can be the existing group ID if the LINE Official Account is still a member of that group.

Official quote:

> `ID of the target recipient. Use a userId, groupId, or roomId value returned in a webhook event object.`

Minimal payload shape:

```json
{
  "to": "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "messages": [
    { "type": "text", "text": "Send TIME" }
  ]
}
```

Limits relevant to this app:

- Max `messages` objects per push request: **5**.
- Push endpoint rate limit: **2,000 requests/second**.
- Error `429` can mean endpoint rate limit, too many messages to same user, or monthly message target limit exceeded.

Official quotes:

> `Messages to send Max: 5`

> `Rate limit 2,000 requests per second`

> `429 ... Exceeded the target limit for sending messages this month.`

Recommendation for implementation:

- Backend should generate and send `X-Line-Retry-Key` as a UUID for scheduled sends to avoid accidental duplicate delivery during retries.
- Treat LINE `409` with the same retry key as “already accepted,” not as a fresh failure.

Official quote:

> `X-Line-Retry-Key ... Retry key. Specifies the UUID in hexadecimal format ... Each developer must generate their own retry key.`

### 2. Conditions for sending to groups

Push message is allowed for group chats where the LINE Official Account has joined.

Official quote:

> `You can send a push message under one of the following conditions:`  
> `Group chats or multi-person chats which your LINE Official Account has been joined`

Error case to surface in the dashboard/logs:

> `400 ... A non-existent group or a group that your LINE Official Account doesn't participate in is specified.`

Recommendation:

- Add a “Verify group” button in the control panel that calls `GET /v2/bot/group/{groupId}/summary` through the backend.
- If LINE returns 400/404-like errors, mark the group inactive and show a clear message: “bot ไม่ได้อยู่ในกลุ่มนี้ / group ID ผิด”.

### 3. Group ID verification endpoint

Use this endpoint to confirm the group ID and display a group name in the UI:

```http
GET https://api.line.me/v2/bot/group/{groupId}/summary
Authorization: Bearer {channel access token}
```

Official quotes:

> `Endpoint: GET https://api.line.me/v2/bot/group/{groupId}/summary`

> `Gets the group ID, group name, and group icon URL of a group chat where the LINE Official Account is a member.`

> `groupId ... Group ID. Found in the source object of webhook event objects.`

Response fields:

```json
{
  "groupId": "Ca56f94637c...",
  "groupName": "Group name",
  "pictureUrl": "https://profile.line-scdn.net/abcdefghijklmn"
}
```

### 4. Quota limit endpoint

Use:

```http
GET https://api.line.me/v2/bot/message/quota
Authorization: Bearer {channel access token}
```

Official quote:

> `Endpoint: GET https://api.line.me/v2/bot/message/quota`

> `Gets the target limit for sending messages in the current month. The total number of the free messages and the additional messages is returned.`

Response shape:

```json
{
  "type": "limited",
  "value": 1000
}
```

Official quote:

> `type ... One of the following values ... none ... limited`

> `value ... The target limit for sending messages in the current month. This property is returned when the type property has a value of limited.`

For this user’s current Free plan, expected dashboard limit is **200/month** unless the API reports a different target. The dashboard should prefer the live API value over the hardcoded plan number.

### 5. Quota consumption endpoint

Use:

```http
GET https://api.line.me/v2/bot/message/quota/consumption
Authorization: Bearer {channel access token}
```

Official quote:

> `Endpoint: GET https://api.line.me/v2/bot/message/quota/consumption`

> `Gets the number of messages sent in the current month.`

Response shape:

```json
{
  "totalUsage": 500
}
```

Official quote:

> `totalUsage ... The number of sent messages in the current month`

Important caveat: this number is approximate.

Official quote:

> `The number of messages retrieved by this operation is approximate. To get the correct number of sent messages, use LINE Official Account Manager or execute API operations for getting the number of sent messages.`

Recommendation:

- Dashboard should label usage as “ประมาณจาก LINE API”.
- Store our own `send_logs` too, but use LINE’s quota API as the source of truth for billing/quota display.
- Never infer remaining quota only from local logs, because LINE also includes messages sent from LINE Official Account Manager.

Official quote:

> `The number of messages retrieved by this operation includes the number of messages sent from LINE Official Account Manager.`

### 6. Free plan / 200 messages per month

The pricing docs show an example subscription table:

Official quote:

> `Number of free messages per month | Up to 200 | Up to 5,000 | Up to 30,000`

The user confirmed their plan is Free, so the planning assumption is **200 messages/month**.

Caveat: LINE says pricing plans vary by country/region, so the production app should still call the quota endpoint instead of assuming 200 forever.

Official quote:

> `Pricing plans vary by country or region, so check the plans for your region.`

### 7. How messages are counted

For group chats, message count is based on the number of people who receive the message, not the number of message objects in the request.

Official quote:

> `The number of messages is counted by the number of people you send a message to. Suppose you send a push message with four message objects in a single request to a chatroom with five people. Here, the number of messages sent is five. The number of message objects in a request doesn't affect the number of messages sent.`

This is critical for the Free 200/month quota: if the group has 10 members and the system sends twice/day, estimated monthly usage is roughly:

```text
10 members × 2 sends/day × 30 days = 600 messages/month
```

So the UI should warn that one group message can consume multiple quota units.

### 8. Which sending methods count toward quota

Official quote:

> `Sending methods that are counted as message count`  
> `Push messages`  
> `Multicast messages`  
> `Broadcast messages`  
> `Narrowcast messages`

Official quote:

> `Sending methods that are not counted as message count`  
> `Reply messages`

For this project, scheduled/manual sends use **push messages**, so they do count toward the monthly message quota.

### 9. Rate limits

General Messaging API rate-limit facts:

Official quote:

> `The Messaging API applies the following rate limits to each API function (endpoint) on a per-channel basis.`

Official quote:

> `Other API endpoints | 2,000 requests per second`

Official quote:

> `If you send requests exceeding the rate limit, you will receive an error message saying, 429 Too Many Requests.`

For this app’s scale, rate limits are not the main constraint. The monthly Free quota is the real constraint.

## Implementation notes for later tickets

1. Backend API should expose `/api/quota` that calls both:
   - `GET /v2/bot/message/quota`
   - `GET /v2/bot/message/quota/consumption`
2. UI should show:
   - plan/limit: live `quota.value` if `type=limited`, fallback “Free plan assumption: 200/month”
   - used: `consumption.totalUsage`
   - remaining: `limit - totalUsage`
   - warning: “LINE นับตามจำนวนผู้รับในกลุ่ม ไม่ใช่จำนวนครั้งที่กดส่ง”
3. Scheduled/manual send endpoint should log:
   - request payload minus secret token
   - HTTP status
   - LINE response body
   - retry key
   - estimated recipient count if available
4. Group management should support verifying a group with `GET /v2/bot/group/{groupId}/summary`.
5. Do not put channel access token in frontend. Store only in Vercel env / server-side runtime.

## Unknowns / items for ticket 03 grilling

- Actual current group member count: needed to estimate quota burn.
- Whether to block scheduled sends when remaining quota is below threshold, or only warn.
- Whether manual sends require confirmation when remaining quota is low.
- Whether quota alert threshold should be percent-based (e.g. 80%) or absolute remaining messages.
