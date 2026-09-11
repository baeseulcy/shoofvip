# ShoofVIP Nuvio Addon

This addon searches ShoofVIP directly at https://shooflive.net using the site's own search, exposes series and episodes to Nuvio, extracts posters from the ShoofVIP pages, and attempts to resolve streams from episode pages/iframes.

## Render
- Build command: `npm install`
- Start command: `node server.js`
- Port: use Render's `PORT` environment variable (the server defaults to 7000 locally).

Manifest after deployment:
`https://YOUR-RENDER-SERVICE.onrender.com/manifest.json`

Add that manifest URL to Nuvio.
