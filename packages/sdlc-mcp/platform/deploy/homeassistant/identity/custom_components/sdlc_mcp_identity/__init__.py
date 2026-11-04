"""Expose the authenticated user's local OIDC binding to the MCP adapter."""
from aiohttp import web
from homeassistant.components.http import HomeAssistantView

from .identity import oidc_subject_hashes


class SdlcMcpIdentityView(HomeAssistantView):
    url = '/api/sdlc-mcp/identity'
    name = 'api:sdlc-mcp:identity'
    requires_auth = True

    async def get(self, request):
        return web.json_response(
            {'oidc_subject_hashes': oidc_subject_hashes(request['hass_user'])},
            headers={'Cache-Control': 'no-store'},
        )


async def async_setup(hass, config):
    hass.http.register_view(SdlcMcpIdentityView())
    return True
