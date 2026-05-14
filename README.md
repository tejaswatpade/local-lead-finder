# Local Lead Finder

Local Lead Finder is a lead discovery and website audit system for local service businesses.

The app lets a user search by niche, location, radius, review count, contact availability, website quality, and map visibility. It discovers qualified local businesses, filters weak matches, audits the website/opportunity, and prepares outreach copy that can be reviewed before use.

Live app: https://local-lead-finder-rose.vercel.app

## What it does

- Finds local businesses using Google Places API and Geocoding.
- Uses smart grid search for large cities and high lead-count searches.
- Filters by reviews, contact type, website status, visibility tier, and opportunity type.
- Deduplicates by Google Place ID, business/address, website domain, and phone.
- Caches Place Details, geocoding, search results, and website scans to reduce API costs.
- Scores leads by relevance, reviews, contact availability, website signals, and map visibility.
- Provides a dashboard for reviewing priority leads, all leads, audit insights, and exports.
- Includes an internal `/dev` usage dashboard for users, campaigns, API calls, and cache hits.

## Run locally

```powershell
Copy-Item .env.example .env.local
# Fill Google OAuth, storage, and Google Places credentials.
npm install
npm run dev
```

Open `http://localhost:3000/login` and sign in with Google.

## Internal dashboard

Set `DEV_DASHBOARD_PASSWORD` to enable the owner dashboard at `/dev`. It is
separate from Google user login and shows users, campaign counts, Google API
calls, Place Details cache hits, and recent runs.

## Google Sheets tabs

The app creates or updates these tabs automatically:

- `Leads`
- `ScrapedData`
- `AuditReports`
- `EmailDrafts`
- `AgentRuns`
- `AgentLogs`
- `Users`
- `PlaceCache`
- `UsageEvents`

Share the Google Sheet with the service account email so the server can write rows.

## Lead Discovery

Lead discovery uses Google Geocoding to convert the campaign location into latitude/longitude, then Google Places API (New) Text Search and Nearby Search with radius, review-count filters, niche relevance scoring, fallback niche terms, and grid points for larger campaigns.

Search depth options:

- `Fast scan`: center search only for speed.
- `Smart grid`: center + nearby grid points for better city coverage.
- `Deep grid`: wider grid expansion for larger markets and 100-lead searches.

Lead filters include:

- contact availability: any reachable, email only, email + phone
- review range
- official website status
- weak website signal
- low/medium/high visibility
- opportunity type: no booking page, no contact page, high rating + low reviews, no website

Set:

- `GOOGLE_PLACES_API_KEY`
- `GOOGLE_GEOCODING_API_KEY` or enable Geocoding API on the same key

The app rejects irrelevant schools, hospitals, history/news/blog pages, directory pages, and weak matches under a relevance score of 50. It enriches only qualified leads with Place Details and website scanning. Place Details responses are cached by Google Place ID to reduce repeat API costs on future searches.

## V1 guardrails

- Dashboard access uses Google sign-in.
- Internal `/dev` access uses `DEV_DASHBOARD_PASSWORD`.
- API keys and service credentials are read only on the server.
- No email sending endpoint exists in V1.
- Drafts must be approved, rejected, edited, or copied manually.
- Local JSON storage is only a development fallback when `LOCAL_DEV_STORAGE=true`.
