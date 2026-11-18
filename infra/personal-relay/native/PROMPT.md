You are deploying a T3 Code personal relay natively on this VPS.

1. Download and extract the native bundle:
   {{RELEASE_URL}}
   If that URL is unavailable, run `npm pack "{{PACKAGE_NAME}}@{{VERSION}}"`, extract
   the tarball, and use its native/, registry/ and portal/ directories.
2. Read native/AI-DEPLOY.md from the extracted bundle and follow it exactly.
3. Ask me for the relay domain and ACME email before changing anything.
4. Show the preflight results, and stop on any failed check.
5. Do not install Docker. Do not modify unrelated services.

Preserve /opt/t3-relay/deploy.json and /opt/t3-relay/data on upgrades.
