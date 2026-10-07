# The README demo: npm run gif (needs npm run db:up and npm run build first)
# An MP4 streams to disk; scripts/gif.ts turns it into the GIF (VHS's own GIF output holds every frame in memory).
Output demo/gif/propmaster-demo.mp4

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms
Set CursorBlink false

Hide
Type "export PROPMASTER_DATABASE_URL=postgres://propmaster:propmaster@postgres:5432/qa_shop PS1='$ '; alias propmaster='node /app/dist/cli.js'; alias shop='node --no-warnings /app/demo/shop.ts'; cd /app" Enter
Type "propmaster install >/dev/null; propmaster record stop >/dev/null 2>&1; shop restock >/dev/null; clear" Enter
Wait@30s /^\$ ?$/
Sleep 2s
Show

Type "# The app said 'Success'. What did it really do to the database?" Enter
Sleep 1.2s
Type 'propmaster record start "Checkout happy path"' Enter
Wait@20s /^\$ ?$/
Sleep 2s

Type 'propmaster record step "Click Place Order"' Enter
Wait@20s /^\$ ?$/
Sleep 1s
Type "shop order 1 3 2          # the tester clicks the button" Enter
Wait@20s /^\$ ?$/
Sleep 2s

Type 'propmaster record step "Cancel the order"' Enter
Wait@20s /^\$ ?$/
Sleep 1s
Type "shop cancel last" Enter
Wait@20s /^\$ ?$/
Sleep 2s

Type "propmaster record stop" Enter
Wait@20s /^\$ ?$/
Sleep 7s

Type "clear" Enter
Type "# Requirement v2 says 10% off for 2+ items. Does this build follow the rules?" Enter
Sleep 0.8s
Type "propmaster record check demo/rules.sql" Enter
Wait@20s /^\$ ?$/
Sleep 8s

Type "clear" Enter
Type "# ...and an HTML report to attach to the bug ticket" Enter
Sleep 0.8s
Type "propmaster record export --format html" Enter
Wait@20s /^\$ ?$/
Sleep 4s
