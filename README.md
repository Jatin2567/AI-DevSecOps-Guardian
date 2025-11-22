# AI-DevSecOps Guardian

AI-DevSecOps Guardian is an intelligence layer for GitLab CI/CD that provides:
- Automated AI-driven job failure diagnosis
- Keyword-based risk detection on successful jobs
- Built-in DevSecOps security controls

## Features

### 1. Automated Job Failure Diagnosis
- Detects failed jobs via webhook
- Fetches and sanitizes job trace
- Uses AI to generate root-cause and fix recommendations
- Auto-creates GitLab Issue

### 2. Keyword-Based Risk Detection
- Scans successful job logs for keywords (warning, deprecated, oom, performance)
- If matched → AI generates “soft alert”
- Creates Issue/Insight only when risk is detected

### 3. DevSecOps Controls
- Webhook token validation
- Secret masking and trace sanitization
- Audit logs
- Least privilege GitLab token usage

## Architecture
GitLab → Webhook → Backend → (Failure? AI Diagnosis) / (Success? Keyword Filter → AI) → Issue Creation

## Setup

### Environment Variables
- GITLAB_API_URL = <api_url>
- GITLAB_TOKEN = <token>
- PORT = <port>
- GITLAB_WEBHOOK_SECRET = <secret>
- MONITORED_JOB_NAMES= <job_names>
- MONITORED_STAGES= <job_stages>
- GITLAB_BASE_URL = <url>
- FP_DB_DIR = <desired_location>
- FP_DB_FILE = <desired_file_name>
- MIN_CONF_CREATE = <desired_value>
- AI_API_KEY= <api_key>   
- AI_MODEL= <desired_model>             
- AI_MAX_RETRIES= <desired_value>
- AI_TIMEOUT_MS= <desired_value>

### Install
npm install

### Run
node server.js

## Webhook Configuration
Enable:
- Pipeline Events
- Job Events

Set secret token same as GITLAB_WEBHOOK_SECRET.

## Output
Creates structured GitLab Issues with:
- Summary
- Root cause
- Fix steps
- Keyword alerts (for success)

## License
MIT
