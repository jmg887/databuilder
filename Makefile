# Build helpers for databuilder.
#
# `make build` installs production dependencies for the shared layer and each
# lambda so that Terraform's archive_file data sources zip complete packages.
# Run this before `terraform apply`.

LAMBDAS := ingest stripe-webhook dashboard-api

.PHONY: build build-lambdas build-shared build-tracking build-dashboard clean

build: build-shared build-lambdas build-tracking build-dashboard

# Shared layer must live under nodejs/ inside the layer zip so it mounts at
# /opt/nodejs. We install its deps then stage a copy under
# infra/build/layer/nodejs, which Terraform zips into the layer. Lambdas
# reference it via require('/opt/nodejs/index').
build-shared:
	cd backend/shared && npm install --omit=dev --no-audit --no-fund
	rm -rf infra/build/layer
	mkdir -p infra/build/layer/nodejs
	cp -r backend/shared/. infra/build/layer/nodejs/

build-lambdas:
	@for l in $(LAMBDAS); do \
		echo "installing deps for $$l"; \
		(cd backend/lambdas/$$l && npm install --omit=dev --no-audit --no-fund); \
	done

build-tracking:
	cd frontend/tracking-script && npm install --no-audit --no-fund && npm run build

build-dashboard:
	cd frontend/dashboard && npm install --no-audit --no-fund && npm run build

# NOTE: frontend/landing has no build step by design (plain static HTML). It is
# rendered (sign-up URL injected) and uploaded directly by Terraform's
# aws_s3_object.landing_index on `terraform apply` — nothing to build here.

clean:
	rm -rf infra/build/*.zip
	find backend -name node_modules -type d -prune -exec rm -rf {} +
	rm -rf frontend/dashboard/dist frontend/tracking-script/dist
