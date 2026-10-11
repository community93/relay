"""Run every E2E suite against a freshly started app.

These suites drive a real window and mutate real persisted state — collections,
environments, tabs, theme. A suite that "restores what it found" still ratchets,
because what it found may already be someone else's leftovers; that showed up as
later suites failing only when an earlier one had run. So each suite gets its own
process and isolated `.design-qa/suite-data`, starting from the seed data.

    python tests/run_all.py            # every suite
    python tests/run_all.py controls latency
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("RELAY_CDP_PORT", "9223"))
EXE = os.environ.get("RELAY_TEST_EXE", os.path.join(ROOT, "dist", "Relay.exe"))
QA_ROOT = os.path.realpath(os.path.join(ROOT, ".design-qa"))
DATA = os.path.realpath(os.path.join(QA_ROOT, "suite-data"))
APP_PROCESS = None

SUITES = [
    "e2e_cdp", "e2e_params", "e2e_env_chain", "e2e_extra",
    "e2e_features", "e2e_upload", "e2e_controls", "e2e_latency",
    "e2e_auth", "e2e_surfaces", "e2e_runner",
]


def kill_app(timeout=20):
    """Wait for the process to actually be gone before the caller wipes data.

    The app flushes its JSON domains on a timer, so killing and immediately
    deleting the isolated suite data can let a dying process write files back — the next
    suite then starts from half a seed and fails in ways that look like product
    bugs.
    """
    global APP_PROCESS
    if APP_PROCESS is not None and APP_PROCESS.poll() is None:
        APP_PROCESS.terminate()
        APP_PROCESS.wait(timeout=timeout)
    APP_PROCESS = None
    # let any in-flight write land and finish before the directory goes away
    time.sleep(1.0)


def wait_for_cdp(timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=3) as r:
                pages = json.load(r)
            if [p for p in pages if p.get("type") == "page"]:
                return True
        except Exception:
            time.sleep(0.5)
    return False


def launch(timeout=60):
    """Start the app and wait for its CDP endpoint.

    A second attempt is not paranoia: right after a kill the old process can
    still hold the debugging port, and then the fresh window comes up too late
    for the first wait and the whole suite reports "did not come up".
    """
    global APP_PROCESS
    for attempt in (1, 2):
        env = dict(os.environ)
        env["RELAY_DATA"] = DATA
        env["WEBVIEW2_USER_DATA_FOLDER"] = os.path.join(QA_ROOT, "suite-webview")
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
            f"--remote-debugging-port={PORT} --remote-allow-origins=*")
        log = open(os.path.join(os.environ.get("TEMP", "/tmp"), "relay-run.log"), "wb")
        APP_PROCESS = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), stdout=log, stderr=log, env=env,
                                      creationflags=subprocess.CREATE_NO_WINDOW)
        if wait_for_cdp(timeout):
            time.sleep(1.5)
            return
        print(f"  launch attempt {attempt} timed out; killing and retrying", flush=True)
        kill_app(timeout=15)
    raise SystemExit("Relay did not come up with a CDP endpoint")


def run_suite(name):
    env=dict(os.environ);env["RELAY_DATA"]=DATA
    proc = subprocess.run([sys.executable, os.path.join(ROOT, "tests", f"{name}.py"), str(PORT)],env=env,
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=1200)
    tally = ""
    for line in proc.stdout.splitlines():
        if "通过" in line and "/" in line:
            tally = line.strip()
    failed = [l for l in proc.stdout.splitlines() if l.startswith("[FAIL]")]
    os.makedirs(os.path.join(QA_ROOT,"suite-logs"),exist_ok=True)
    with open(os.path.join(QA_ROOT,"suite-logs",name+".log"),"w",encoding="utf-8") as log:
        log.write(proc.stdout+"\nSTDERR:\n"+proc.stderr)
    return tally, failed, proc


def main():
    wanted = sys.argv[1:] or SUITES
    names = [w if w.startswith("e2e_") else f"e2e_{w}" for w in wanted]
    if not os.path.exists(EXE):
        raise SystemExit(f"{EXE} missing — build it first")
    if os.path.commonpath([DATA, QA_ROOT]) != QA_ROOT or DATA == QA_ROOT:
        raise SystemExit("Refusing to reset data outside the isolated QA directory")
    if wait_for_cdp(timeout=1):
        raise SystemExit(f"CDP port {PORT} is already occupied; choose RELAY_CDP_PORT")

    total = passed = 0
    broken = []
    suite_rows = []
    for name in names:
        kill_app()
        shutil.rmtree(DATA, ignore_errors=True)   # isolated QA data only
        launch()
        tally, failed, proc = run_suite(name)
        if "/" in tally:
            p, _, a = tally.partition("/")
            total += int(a.split()[0])
            passed += int(p)
        else:
            total += 1
            if failed:
                print(f"  {name}: {tally or 'no tally'}")
        print(f"{name:20s} {tally or 'NO RESULT'}", flush=True)
        suite_rows.append({"suite": name, "result": tally, "exit": proc.returncode, "failures": failed})
        for line in failed:
            # 80 chars used to cut the payload dict mid-key, which is exactly the
            # part that explains the failure.
            broken.append(f"{name}: {line[6:400]}")
        if proc.returncode != 0 and not failed:
            broken.append(f"{name}: exited {proc.returncode} — {(proc.stderr or '')[-200:]}")
    kill_app()
    with open(os.path.join(QA_ROOT, 'python-full-results.json'), 'w', encoding='utf-8') as report:
        json.dump({"exe": EXE, "passed": passed, "total": total, "suites": suite_rows, "failures": broken}, report, ensure_ascii=False, indent=2)

    print(f"\n{passed}/{total} 通过，{len(names)} 个套件，每个套件都是全新进程 + 干净数据")
    for line in broken:
        print("  " + line)
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
