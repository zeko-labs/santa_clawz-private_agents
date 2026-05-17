# Smoke Test Result

Ran from inside this bundle:

```bash
python3 santaclawz_real_worker_bridge.py --once examples/requests/santaclawz_agent_job_pack.json
```

Result:

- exit code: `0`
- request: `scz-run-agent-pack-001`
- deliverables: `13`
- verification manifest: present
- Zeko attestation payload: present
- run receipt: present
- package hash: present
- manifest file hashes: `13`
- bridge quality gate: passed

This confirms the demo is self-contained and does not require the parent workspace.

Runtime output is intentionally excluded from the packaged zip; the protocol repo should treat `output/` as generated data.
