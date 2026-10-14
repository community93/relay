"""Isolated real WS fixtures for handshake, duplex, Ping/Pong and failures."""
import asyncio
import json
import ssl
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


async def handshake(connection, request):
    path = urlsplit(request.path).path
    if path == '/reject':
        return connection.respond(401, 'Authentication required')
    if path == '/stall':
        await asyncio.sleep(10)
    if path == '/auth':
        expected = {'Authorization': 'Bearer live-token', 'Origin': 'https://relay.test', 'Cookie': 'session=fixture', 'X-Collection': 'inherited'}
        if any(request.headers.get(key) != value for key, value in expected.items()):
            return connection.respond(403, 'Missing auth/header')
        if request.headers.get_all('Upgrade') != ['websocket'] or request.headers.get_all('Sec-WebSocket-Version') != ['13']:
            return connection.respond(400, 'Duplicate managed header')
        if parse_qs(urlsplit(request.path).query).get('token') != ['one+two']:
            return connection.respond(400, 'Duplicated or damaged query')
    return None


async def handler(socket):
    path = urlsplit(socket.request.path).path
    if path == '/close':
        await socket.close(1008, 'token expired')
        return
    await socket.send(json.dumps({'hello': True, 'subprotocol': socket.subprotocol, 'path': socket.request.path}))
    if path == '/ping':
        waiter = await socket.ping(b'check')
        await asyncio.wait_for(waiter, 2)
        await socket.send('pong-confirmed')
    async def push():
        if path != '/duplex': return
        for index in range(150):
            await socket.send(json.dumps({'push': index}))
            await asyncio.sleep(.008)
    task = asyncio.create_task(push())
    try:
        async for message in socket:
            await socket.send(message)
    except ConnectionClosed:
        pass
    finally:
        task.cancel()


def ensure_cert(root):
    """Mint the localhost cert the wss fixture needs.

    `create_ws_cert.ps1` uses `ExportCertificatePem` / `ExportPkcs8PrivateKeyPem`,
    which are .NET 5+ APIs — so it needs PowerShell 7 and fails on a box that only
    has Windows PowerShell 5.1. openssl does the same job and is far more common,
    so the fixture works wherever Python does.
    """
    target = root / '.design-qa' / 'ws-certificate'
    cert, key = target / 'cert.pem', target / 'key.pem'
    if cert.exists() and key.exists():
        probe = subprocess.run(['openssl', 'x509', '-checkend', '3600', '-noout', '-in', str(cert)],
                               capture_output=True)
        if probe.returncode == 0:
            return
    target.mkdir(parents=True, exist_ok=True)
    for command in (
        ['pwsh', '-NoProfile', '-File', str(root / 'tests/create_ws_cert.ps1')],
        ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
         '-keyout', str(key), '-out', str(cert), '-subj', '/CN=localhost',
         '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    ):
        try:
            if subprocess.run(command, check=True, capture_output=True).returncode == 0:
                return
        except (OSError, subprocess.CalledProcessError):
            continue
    raise RuntimeError('Neither pwsh nor openssl can mint the fixture certificate')


async def main():
    root=Path(__file__).resolve().parent.parent
    ensure_cert(root)
    tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(root/'.design-qa/ws-certificate/cert.pem',root/'.design-qa/ws-certificate/key.pem')
    async with serve(handler, '127.0.0.1', 19001, process_request=handshake,
                     subprotocols=['relay.json'], select_subprotocol=lambda conn, values: 'relay.json' if 'relay.json' in values else None,
                     ping_interval=None), serve(handler,'127.0.0.1',19002,ssl=tls,ping_interval=None):
        print('WS protocol fixture 19001 ready', flush=True)
        await asyncio.Future()


if __name__ == '__main__': asyncio.run(main())
