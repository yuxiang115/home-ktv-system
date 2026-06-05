# Controller User Accounts Design

## Goal

Add simple user accounts to the controller so every queued song can be tied to a real person, and anonymous users cannot request songs.

## Scope

- Single room, single TV runtime stays unchanged.
- Multiple controller phones can use the system at the same time.
- Controller users register and log in with phone number plus password.
- Password length must be at least 5 characters.
- Display name is the user's editable nickname.
- Login is remembered through a long-lived server session cookie.
- Guests cannot search, browse recommendations, send interactions, or queue songs.

## Architecture

Add a controller account layer beside the existing control session layer.

- `controller_users` stores phone number, display name, password hash, and timestamps.
- `controller_auth_sessions` stores hashed auth tokens for remembered login.
- `room_clients` remains the device/control-session record and can optionally store the bound user phone.
- `queue_entries` keeps the existing `requested_by` device marker for debugging, and adds user phone plus display name snapshot for product history.

The existing pairing/control session still represents the physical controller browser. Auth represents the person using it.

## API

- `POST /controller/auth/register`: create user and auth session.
- `POST /controller/auth/login`: verify password and create auth session.
- `GET /controller/auth/me`: return current user or `401 AUTH_REQUIRED`.
- `POST /controller/auth/logout`: revoke the current auth session.
- `PATCH /controller/auth/profile`: update display name.
- Control session restore/create and controller commands require auth.

## Controller UI

When not logged in, the controller shows a full-screen login/register experience. After login, the existing Home and 操控 tabs are shown.

The account area shows display name and phone number, supports editing display name, logout, and switching account. Search and recommendations are not visible before login.

Queue rows show the requester display name when available, for example `张三 点的`. A simple "我的历史" area lists the current user's recent queue entries.

## Error Handling

- Duplicate phone registration returns `USER_ALREADY_EXISTS`.
- Invalid login returns `INVALID_CREDENTIALS`.
- Missing auth returns `AUTH_REQUIRED`.
- Invalid display name returns `INVALID_DISPLAY_NAME`.
- Invalid password length returns `INVALID_PASSWORD`.

## Testing

- API route tests for register, login, me, logout, and profile update.
- Command route tests proving guests cannot queue songs.
- Queue repository/service tests proving accepted queue entries store user phone and display name snapshot.
- Controller tests proving unauthenticated users see login/register first and authenticated users can enter the app.
