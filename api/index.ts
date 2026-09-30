// Vercel entry point: vercel.json rewrites every /api/* request here, to the same Express app
// that `npm start` runs. The front end is served from dist/ by Vercel's CDN.
import app from '../server/app.js';

export default app;
