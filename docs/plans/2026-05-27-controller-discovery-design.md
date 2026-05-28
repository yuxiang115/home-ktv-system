# Controller Discovery UI Design

Date: 2026-05-27

## Goal

Build the first web-controller version of the KTV discovery home page before any Android UI work.

## Scope

This change is limited to the mobile web controller and backend data needed by it. Android TV UI is intentionally out of scope until the web flow is validated.

## Home Structure

The mobile controller home keeps the current playback panel at the top, then changes the song discovery area to this order:

1. Search entry
2. Singer discovery
3. Genre discovery
4. Recommended list
5. Playback queue

The search entry is a launcher, not a full inline result list. The main page stays focused on browsing and quick selection.

## Search Overlay

Tapping the search field opens a full-screen overlay.

When the query is empty:

- Show recent local search history.
- History items are stored in `localStorage` on the phone.
- Tapping a history item immediately searches it.
- A clear action in the lower right removes all history.

When the query has content:

- Search as the user types.
- Show related songs below the input.
- Reuse the existing local/indexed/online search result layout and queue actions.

## Discovery Data

Add a separate backend discovery endpoint:

`GET /rooms/:roomSlug/songs/discovery?seed=...`

The endpoint returns:

- `recommended`: 30 queueable songs selected by weighted random.
- `artists`: prominent artists with a preview song count.
- `genres`: prominent genres with a preview song count.

Recommendation weight is global across the system. It uses historical `queue_entries` counts for each song, with a base weight so songs that have never been selected can still appear.

The endpoint still accepts a room slug so each returned song can include the current room `queueState`.

## First Version Constraints

- No route library is introduced.
- "More" views for artists and genres are in-page states.
- Song cards reuse the same add/duplicate behavior as current search results.
- The UI keeps the existing dark family-living-room technology direction.
