.PHONY: help start stop status demo-reset up up-mock ens-fork ens-issue gmail-connect world-setup web-dev share-build activity

help:
	@echo "Hmail commands"
	@echo "  make demo-reset   stop the house, archive it, and print a fresh name for a from-scratch demo"
	@echo "  make start        start your house in the background (opens http://localhost:8390)"
	@echo "  make status       show whether your house is running"
	@echo "  make stop         stop your house"
	@echo "  make activity     who asked for which code, and what happened"
	@echo "  make up           run the house in this terminal instead"
	@echo ""
	@echo "Demo: make demo-reset, then open https://hmail-web.vercel.app and click Copy setup prompt."
	@echo "On Grok (optional, to show the World ID link-up again): rm -rf ~/.hors/hmail-assistant"

up:
	@[ -d node_modules ] || pnpm install
	@node --env-file-if-exists=.env.local bin/hmail.js up $(ARGS)

start:
	@[ -d node_modules ] || pnpm install
	@node --env-file-if-exists=.env.local bin/hmail.js up --background $(ARGS)

stop:
	@node bin/hmail.js stop $(ARGS)

status:
	@node bin/hmail.js status $(ARGS)

demo-reset:
	@bash scripts/demo-reset.sh

up-mock:
	@[ -d node_modules ] || pnpm install
	@node --env-file-if-exists=.env.local bin/hmail.js up --mock $(ARGS)

world-setup:
	@node --env-file-if-exists=.env.local bin/hmail.js world-setup $(ARGS)

web-dev:
	@node --env-file-if-exists=.env.local web/dev-server.mjs

gmail-connect:
	@node --env-file-if-exists=.env.local bin/hmail.js gmail-connect $(ARGS)

ens-fork:
	anvil --fork-url $(or $(SEPOLIA_RPC_URL),https://ethereum-sepolia-rpc.publicnode.com) --port 8546

ens-issue:
	@node --env-file-if-exists=.env.local scripts/ens-issue.mjs $(ARGS)

share-build:
	@node scripts/share-build.mjs

activity:
	@node --env-file-if-exists=.env.local bin/hmail.js activity $(ARGS)
