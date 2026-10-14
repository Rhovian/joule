# Joule Fill

Load this directory unpacked from Chrome's `chrome://extensions` with Developer mode enabled. Open extension Options, enter the joule origin (for example `http://localhost:8000` or the Tailscale Serve HTTPS origin), and click **Save and Test**. For a server, set joule's `UPWORK_REDIRECT_URI` to allow the tailnet hostname.

Open a Greenhouse, Lever or Ashby form, click the extension toolbar action to open the side panel, refresh Jobs, select the intended Job, and click **Fill**. Reload a form that was already open when the extension was installed. Review the values and complete the remaining fields yourself. Job state stays manual.

This slice fills text only. Resume attachment, Ask, saved answers and injection on other sites are subsequent slices. Static scripts run in matching ATS frames, including employer-hosted embeds. If an embed cannot be reached, open its URL directly. Actual Chrome permissions, cross-origin frames, React widgets and real ATS behavior still need the operator's manual trial (design §5).

Run the focused checks with `npm ci && npm test` in this directory. JS intentionally has no build step (design D14). `test/fixtures` contains small reconstructions of the markup verified in the design record, rather than full fetched pages. jsdom's missing layout is stubbed in tests; the production visibility checks use real rectangles.
