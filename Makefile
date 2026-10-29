# Dev shortcuts (macOS/Linux/WSL). Windows PowerShell commands are in README.
PY := backend/.venv/bin/python

.PHONY: setup env dev dev-backend dev-frontend test sql-test lint check e2e-accounts e2e docker

setup:            ## Create venv, install backend + frontend deps
	cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
	cd frontend && npm install

env:              ## Create local env files from the examples (won't overwrite)
	@[ -f backend/.env ] || cp backend/.env.example backend/.env
	@[ -f frontend/.env.local ] || cp frontend/.env.example frontend/.env.local
	@echo "Now fill in backend/.env and frontend/.env.local"

dev-backend:      ## API on http://localhost:8000
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000 --no-proxy-headers

dev-frontend:     ## Web app on http://localhost:3000
	cd frontend && npm run dev

dev:              ## Run both (Ctrl+C stops both)
	$(MAKE) -j2 dev-backend dev-frontend

test:
	cd backend && .venv/bin/pytest -q

sql-test:         ## Every migration + every SQL test on an EMPTY Postgres: make sql-test DATABASE_URL=postgresql://...
	DATABASE_URL=$(DATABASE_URL) supabase/tests/ci/run_sql_tests.sh

docker:           ## Build the API and web images (NEXT_PUBLIC_* from frontend/.env.local)
	docker build -t school-erp-api backend
	set -a; . frontend/.env.local; set +a; docker build -t school-erp-web frontend \
	  --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY --build-arg NEXT_PUBLIC_API_URL

lint:
	cd backend && .venv/bin/ruff check . --exclude .venv && .venv/bin/ruff format --check . --exclude .venv
	cd frontend && npm run lint

check: lint test  ## Everything CI should run
	cd frontend && npm run typecheck && npm run build

e2e-accounts:     ## Create E2E test users in the (non-production) Supabase project
	cd backend && .venv/bin/python -m scripts.create_test_accounts

e2e:              ## Browser tests; app must be running
	cd frontend && npm run test:e2e
