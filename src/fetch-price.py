"""Bounded transport fallback for public OpenAI documentation; no API credentials."""
import sys
import urllib.request

ALLOWED = {
    'https://developers.openai.com/api/docs/models/gpt-6-sol.md',
    'https://developers.openai.com/api/docs/models/gpt-6.1-sol.md',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in ALLOWED:
        raise SystemExit('Unsupported official source')
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(sys.argv[1], timeout=12) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise SystemExit('Price page too large')
        sys.stdout.buffer.write(data)
