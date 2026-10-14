# Joule Fill

Load this directory unpacked from Chrome's `chrome://extensions` with Developer mode enabled. Open extension Options, enter the joule origin (for example `http://localhost:8000` or the Tailscale Serve HTTPS origin), and click **Save and Test**. For a server, set joule's `UPWORK_REDIRECT_URI` to allow the tailnet hostname.

Open a Greenhouse, Lever or Ashby form, click the extension toolbar action to open the side panel, refresh Jobs, select the intended Job, and click **Fill**. Reload a form that was already open when the extension was installed. Review the values and complete the remaining fields yourself. Job state stays manual.

On other sites, right-click the page or a field and choose **Fill with Joule**, or press **Ctrl+Shift+Y** (**Command+Shift+Y** on macOS). This injects the same worker using temporary `activeTab` access and opens the side panel; select the intended Job and click **Fill**. Change the shortcut at `chrome://extensions/shortcuts` if it conflicts. Upwork, LinkedIn, Indeed and Glassdoor, including subdomains, are refused.

Fill replays exact normalized question matches from `profile/answers.yaml`, mapping saved option labels to select/radio values. For unmatched questions, click **Ask** beside the field; answers come from your Profile and appear only in empty fields. Review and edit the result, then click **Save to bank** to save the field's current answer (the option label for selects/radios). You can also save manually answered or filled fields. Next Fill replays the saved answer; saves are refused when the bank already exceeds 200 KB. Sensitive questions stay manual, including when saved in the bank. An unanswerable option question stays empty. Ask alone does not save answers.

Use **Attach resume** for the latest Tailored CV, or **Generate and attach resume** if none exists. Cover Letter attachment uses an existing Draft. Static scripts run in matching ATS frames, including employer-hosted embeds. Unknown-site injection targets the main frame; if an embed cannot be reached, open its URL directly and use the context menu or command there. Actual Chrome permissions, cross-origin frames, React widgets and real ATS behavior still need the operator's manual trial (design §5).

Run the focused checks with `npm ci && npm test` in this directory. JS intentionally has no build step (design D14). `test/fixtures` contains small reconstructions of the markup verified in the design record, rather than full fetched pages. jsdom's missing layout is stubbed in tests; the production visibility checks use real rectangles.
