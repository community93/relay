"""Run current JS acceptance suites, each in its own native process and QA data."""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QA = os.path.realpath(os.path.join(ROOT, ".design-qa"))
DATA = os.path.realpath(os.path.join(QA, "native-data"))
EXE = os.environ.get("RELAY_TEST_EXE", os.path.join(ROOT, "dist", "Relay.exe"))
PORT = int(os.environ.get("RELAY_CDP_PORT", "9225"))
SUITES = ["workspace", "usability", "variables", "preview", "import_names",
          "response_layout", "body_editor", "interaction_design", "document_design", "delivery", "data_directory", "typography", "themes", "list_sorting", "list_sorting_restart", "protocol_persistence", "protocol_restart", "apple_interactions", "run_details", "runner_data", "visual_craft", "protocol_import", "motion_cascade", "checks_chain", "checks_restart", "format_import", "automation", "automation_restart"]

def ready():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2) as r:
            return any(p.get("type") == "page" for p in json.load(r))
    except Exception:
        return False

def main():
    if os.path.commonpath([DATA, QA]) != QA or DATA == QA:
        raise RuntimeError("QA data path is unsafe")
    if ready():
        raise RuntimeError("CDP port occupied")
    rows=[]
    log_dir=os.path.join(QA,"suite-logs");os.makedirs(log_dir,exist_ok=True)
    for suite in sys.argv[1:] or SUITES:
        name=suite if suite.startswith("e2e_") else "e2e_"+suite
        if name not in ('e2e_protocol_restart', 'e2e_list_sorting_restart', 'e2e_checks_restart', 'e2e_automation_restart'):
            shutil.rmtree(DATA,ignore_errors=True)
        env=dict(os.environ,RELAY_DATA=DATA,RELAY_CDP_URL=f"http://127.0.0.1:{PORT}",
                 WEBVIEW2_USER_DATA_FOLDER=os.path.join(QA,"fulltest-webview"),
                 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f"--remote-debugging-port={PORT} --remote-allow-origins=*")
        process=subprocess.Popen([EXE],cwd=os.path.dirname(EXE),env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        fixture=None
        try:
            if name=='e2e_protocol_import':
                fixture=subprocess.Popen([sys.executable,os.path.join(ROOT,'tests','ws_protocol_server.py')],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW)
            if name=='e2e_checks_chain':
                fixture=subprocess.Popen([sys.executable,os.path.join(ROOT,'tests','check_chain_server.py')],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW)
            if name=='e2e_automation':
                fixture=subprocess.Popen([sys.executable,os.path.join(ROOT,'tests','check_chain_server.py')],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW)
            deadline=time.time()+45
            while not ready():
                if time.time()>deadline:raise RuntimeError("Native window did not start")
                time.sleep(.3)
            result=subprocess.run(["node",os.path.join(ROOT,"tests",name+".cjs")],cwd=ROOT,env=env,
                                  capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=300)
            output=result.stdout+"\nSTDERR:\n"+result.stderr
            with open(os.path.join(log_dir,name+"-native.log"),"w",encoding="utf-8") as log:log.write(output)
            tally=re.search(r"(\d+)/(\d+) passed",output)
            row={"suite":name,"exit":result.returncode,"passed":int(tally[1]) if tally else 0,"total":int(tally[2]) if tally else 1}
            rows.append(row)
            print(f"{name}: {row['passed']}/{row['total']} exit {row['exit']}",flush=True)
            if result.returncode:print(output[-2200:],flush=True)
        finally:
            if fixture is not None and fixture.poll() is None:fixture.terminate();fixture.wait(timeout=20)
            if process.poll() is None:process.terminate();process.wait(timeout=20)
            time.sleep(1)
    report={"exe":EXE,"suites":rows,"passed":sum(r['passed'] for r in rows),"total":sum(r['total'] for r in rows)}
    with open(os.path.join(QA,"native-full-results.json"),"w",encoding="utf-8") as out:json.dump(report,out,ensure_ascii=False,indent=2)
    print(f"{report['passed']}/{report['total']} passed",flush=True)
    return int(any(row['exit'] for row in rows))

if __name__=="__main__":sys.exit(main())
