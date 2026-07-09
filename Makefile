# Mandalika POS — repo-level make targets.
# (Backend-specific targets live in backend/Makefile.)

.PHONY: ota-release
ota-release: ## Publish a POS OTA bundle: make ota-release VERSION=x.y.z
	@bash scripts/ota-release.sh
