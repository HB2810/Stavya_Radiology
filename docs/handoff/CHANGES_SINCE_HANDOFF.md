# Changes since the handoff chapters were written (1 Oct 2026)

Chapters 01 to 09 describe the system as of 1 October 2026. These later changes are in the code but not yet folded into the chapters.

| Date | Change | Where |
|---|---|---|
| 2 Oct 2026 | **Seed data.** `npm run seed` now creates 29 guided samples (one case per situation, per role) instead of bulk random traffic. `--traffic` gives the old bulk set, `--empty` gives staff and three patients only. Chapter 07 §6 still describes the bulk set as the default. | `server/guided-data.js`, `server/seed.js`, `README.md` |
| 2 Oct 2026 | **Catalog.** The guided seed hides the 15 placeholder exams that predate the hospital charge sheet (`active = 0`, `source = 'SEED'`) and copies their body part, preparation note and search keywords to the hospital equivalents. | `server/guided-data.js` (`tidyCatalog`) |
| 2 Oct 2026 | **Safety screening fix.** The safety screening form was not shown once a scan reached PREPARED, so a scan could not be started. The form now shows at PREPARED, and Start is disabled with a hint until a cleared screening exists. UI only; the server rule is unchanged. | `web/src/pages/Order.jsx` |
| 2 Oct 2026 | **Imaging orders table.** Column widths fixed so the Action column is visible. | `web/src/extras.css` |
| 2 Oct 2026 | **LAN use.** Start with `HOST=0.0.0.0` to reach the system from other devices on the same network. | `server/config.js` (existing setting) |

## Known gap found on 2 Oct 2026

Online payments are billed at the cash price. `exam_catalog.online_price` is stored and editable, but order pricing reads only `exam_catalog.price`, so a scan paid online is charged the cash rate. See `server/orders.js` (`createOrder`) and `server/billing.js`.
