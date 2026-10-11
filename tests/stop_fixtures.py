"""Frees the fixture ports (8899/8900) so `local_server.py` can be restarted."""

import subprocess
import sys


def pids_for(port):
    output = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, errors="ignore").stdout
    return {line.split()[-1] for line in output.splitlines() if f":{port}" in line and "LISTENING" in line}


def main():
    ports = [int(arg) for arg in (sys.argv[1:] or ["8899", "8900"])]
    killed = 0
    for port in ports:
        for pid in pids_for(port):
            subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True)
            print(f"stopped :{port} (pid {pid})")
            killed += 1
    if not killed:
        print("nothing listening on", ", ".join(str(port) for port in ports))


if __name__ == "__main__":
    main()
