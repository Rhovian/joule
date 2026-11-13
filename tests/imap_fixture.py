"""Local TLS IMAP fixture for the email connection test."""

import shlex
import shutil
import socketserver
import ssl
import subprocess
from contextlib import contextmanager
from datetime import UTC, datetime
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from threading import Thread

import pytest

PASSWORD = "fixture-app-password-139"
USERNAME = "local operator"


@contextmanager
def imap_server(directory, implicit=True):
    if not shutil.which("openssl"):
        pytest.skip("openssl is required for the local TLS fixture")
    directory.mkdir(parents=True, exist_ok=True)
    certificate, key = directory / "cert.pem", directory / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)

    class Handler(socketserver.StreamRequestHandler):
        def setup(self):
            self.secure = implicit
            if implicit:
                self.request = context.wrap_socket(self.request, server_side=True)
            super().setup()

        def handle(self):
            self.wfile.write(b"* OK Local fixture ready\r\n")
            while line := self.rfile.readline():
                tag, command, *args = shlex.split(line.decode().strip())
                server.commands.append((command, self.secure))
                response = "OK done"
                if command == "CAPABILITY":
                    self.wfile.write(b"* CAPABILITY IMAP4rev1 STARTTLS\r\n")
                elif command == "STARTTLS":
                    self.wfile.write(f"{tag} OK Begin TLS\r\n".encode())
                    self.wfile.flush()
                    self.connection = context.wrap_socket(
                        self.connection, server_side=True
                    )
                    self.rfile = self.connection.makefile("rb")
                    self.wfile = self.connection.makefile("wb")
                    self.secure = True
                    continue
                elif command == "LOGIN":
                    if server.drop_on_login:
                        return
                    if (
                        not self.secure
                        or not server.allow_login
                        or args != [USERNAME, PASSWORD]
                    ):
                        response = f"NO authentication failed; server echoes {PASSWORD}"
                elif command == "UID":
                    server.uid_requests.append(args)
                    if args[0] == "SEARCH":
                        ids = list(server.messages)
                        if args[1] == "UID":
                            ids = [
                                uid for uid in ids if uid >= int(args[2].split(":")[0])
                            ]
                        else:
                            cutoff = (
                                datetime.strptime(args[2], "%d-%b-%Y")
                                .replace(tzinfo=UTC)
                                .date()
                            )
                            ids = [
                                uid
                                for uid in ids
                                if parsedate_to_datetime(
                                    str(
                                        BytesParser(policy=policy.default).parsebytes(
                                            server.messages[uid]
                                        )["Date"]
                                    )
                                ).date()
                                >= cutoff
                            ]
                        self.wfile.write(
                            ("* SEARCH " + " ".join(map(str, ids)) + "\r\n").encode()
                        )
                    elif args[0] == "FETCH":
                        raw = server.messages[int(args[1])][:16384]
                        self.wfile.write(
                            f"* 1 FETCH (UID {args[1]} BODY[] {{{len(raw)}}}\r\n".encode()
                            + raw
                            + b")\r\n"
                        )
                    else:
                        response = "BAD unexpected UID command"
                elif command == "EXAMINE":
                    server.folders.append(args[0])
                    if args[0] not in ("INBOX", "Jobs &- Careers", "Jobs &- &U,BTFw-"):
                        response = "NO no such folder"
                    else:
                        self.wfile.write(
                            f"* 0 EXISTS\r\n* OK [UIDVALIDITY {server.validity}] valid\r\n".encode()
                        )
                elif command == "LOGOUT":
                    self.wfile.write(f"* BYE closing\r\n{tag} OK logout\r\n".encode())
                    return
                else:
                    response = "BAD unexpected command"
                self.wfile.write(f"{tag} {response}\r\n".encode())
                self.wfile.flush()

    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler) as server:
        server.daemon_threads = True
        server.allow_login, server.drop_on_login = True, False
        server.commands, server.folders = [], []
        server.messages, server.uid_requests, server.validity = {}, [], "1"
        server.certificate = certificate
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join()
