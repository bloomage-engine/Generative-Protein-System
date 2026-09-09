/**
 * Dev helper: wait for the example server (:3300, or $PORT) to start
 * listening before Vite boots.
 *
 * `npm run dev` starts the server and this web script together via
 * concurrently. Vite comes up faster than the server (tsx boot), so the
 * browser — a freshly opened tab, or an existing tab that Vite auto-reloads on
 * reconnect — can fire its mount probe and /api/transport/watch channel while
 * nothing listens yet. The Vite proxy then logs ECONNREFUSED, and because the
 * probe is one-shot, the load-time history import is lost for that page (the
 * watch channel does recover on its own reconnect loop, but a cold dsh server
 * has no in-memory transcript to push until the first POST). Booting Vite only
 * after the server accepts connections closes that race.
 */
const port = process.env.PORT ?? "3300";
const started = Date.now();
const deadline = started + 15_000;

function poll() {
  if (Date.now() > deadline) {
    console.log(`[dev:web] example server not up on :${port} after 15s — starting Vite anyway`);
    process.exit(0);
  }
  // Any HTTP response (even the 404 for "/") proves the port is listening;
  // only connection errors keep polling.
  fetch(`http://127.0.0.1:${port}/`)
    .then(() => process.exit(0))
    .catch(() => {
      setTimeout(poll, 200);
    });
}

poll();
