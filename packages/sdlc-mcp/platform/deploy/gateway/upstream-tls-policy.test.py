#!/usr/bin/env python3
"""Exercise the gateway's nginx TLS policy inside the pinned gateway image."""

import subprocess
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


class UpstreamTLSPolicyTest(unittest.TestCase):
    def test_trust_and_hostname_are_required(self):
        processes = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def openssl(*args):
                subprocess.run(["openssl", *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            ca_key, ca_cert = root / "ca.key", root / "ca.crt"
            openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=Test CA", "-keyout", str(ca_key), "-out", str(ca_cert))
            bundle = Path("/gateway-ca/combined-v2.pem")
            bundle.parent.mkdir(parents=True, exist_ok=True)
            bundle.write_bytes(ca_cert.read_bytes())

            def certificate(name, hostname, trusted):
                key, cert, csr, ext = (root / f"{name}.{suffix}" for suffix in ("key", "crt", "csr", "ext"))
                if trusted:
                    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={hostname}",
                            "-keyout", str(key), "-out", str(csr))
                    ext.write_text(f"subjectAltName=DNS:{hostname}\n")
                    openssl("x509", "-req", "-in", str(csr), "-CA", str(ca_cert), "-CAkey", str(ca_key),
                            "-CAcreateserial", "-days", "1", "-extfile", str(ext), "-out", str(cert))
                else:
                    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", f"/CN={hostname}", "-addext", f"subjectAltName=DNS:{hostname}",
                            "-keyout", str(key), "-out", str(cert))
                return key, cert

            config = root / "nginx.conf"
            dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            dns.bind(("127.0.0.1", 0))
            dns.settimeout(0.1)
            stop_dns = threading.Event()

            def serve_dns():
                while not stop_dns.is_set():
                    try:
                        query, address = dns.recvfrom(1024)
                    except socket.timeout:
                        continue
                    position = 12
                    while query[position]:
                        position += query[position] + 1
                    end = position + 5
                    is_a = query[end - 4:end - 2] == b"\x00\x01"
                    response = (
                        query[:2] + b"\x81\x80\x00\x01" + (b"\x00\x01" if is_a else b"\x00\x00")
                        + b"\x00\x00\x00\x00" + query[12:end]
                    )
                    if is_a:
                        response += b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x1e\x00\x04\x7f\x00\x00\x01"
                    dns.sendto(response, address)

            dns_thread = threading.Thread(target=serve_dns, daemon=True)
            dns_thread.start()
            config.write_text(
                "events {}\nhttp {\n"
                "include /etc/nginx/conf.d/00-sdlc-upstream-tls.conf;\n"
                "server { listen 127.0.0.1:18080;\n"
                f"resolver 127.0.0.1:{dns.getsockname()[1]} ipv6=off;\n"
                "location /plaintext { proxy_pass http://127.0.0.1:18446/; }\n"
                + "".join(
                    f"location /{name} {{ proxy_pass https://127.0.0.1:{port}; proxy_ssl_name localhost; }}\n"
                    for name, port in (("trusted", 18443), ("wrong-host", 18444), ("untrusted", 18445))
                )
                + "".join(
                    f"location /dynamic-{name} {{ set $backend_{index} https://localhost:{port}; "
                    f"proxy_pass $backend_{index}; }}\n"
                    for index, (name, port) in enumerate((("trusted", 18443), ("wrong-host", 18444), ("untrusted", 18445)))
                )
                + "}\n}\n"
            )
            try:
                for name, hostname, trusted, port in (
                    ("trusted", "localhost", True, 18443),
                    ("wrong-host", "other.localhost", True, 18444),
                    ("untrusted", "localhost", False, 18445),
                ):
                    key, cert = certificate(name, hostname, trusted)
                    processes.append(subprocess.Popen(
                        ["openssl", "s_server", "-accept", f"127.0.0.1:{port}", "-cert", str(cert),
                         "-key", str(key), "-www", "-quiet"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    ))
                processes.append(subprocess.Popen(
                    [sys.executable, "-m", "http.server", "18446", "--bind", "127.0.0.1"],
                    cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                ))
                for port in (18443, 18444, 18445, 18446):
                    deadline = time.monotonic() + 10
                    while True:
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=1):
                                break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.1)
                subprocess.run(["nginx", "-t", "-c", str(config)], check=True, stdout=subprocess.DEVNULL)
                processes.append(subprocess.Popen(
                    ["nginx", "-c", str(config), "-g", "daemon off;"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                ))
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with urllib.request.urlopen("http://127.0.0.1:18080/trusted", timeout=2) as response:
                            self.assertEqual(response.status, 200)
                        break
                    except urllib.error.URLError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.1)
                with urllib.request.urlopen("http://127.0.0.1:18080/dynamic-trusted", timeout=5) as response:
                    self.assertEqual(response.status, 200)
                with urllib.request.urlopen("http://127.0.0.1:18080/plaintext", timeout=5) as response:
                    self.assertEqual(response.status, 200)
                for name in ("wrong-host", "untrusted", "dynamic-wrong-host", "dynamic-untrusted"):
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(f"http://127.0.0.1:18080/{name}", timeout=5)
                    with error.exception:
                        self.assertEqual(error.exception.code, 502)
            finally:
                for process in reversed(processes):
                    process.terminate()
                for process in reversed(processes):
                    process.wait(timeout=10)
                stop_dns.set()
                dns_thread.join(timeout=1)
                dns.close()


if __name__ == "__main__":
    unittest.main()
