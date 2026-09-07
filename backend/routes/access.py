"""Session endpoints for the optional hosted password gate."""
from __future__ import annotations

import os

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services import access_service


router = APIRouter()


class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=512)


def _secure_cookies() -> bool:
    """Send Secure cookies unless explicitly disabled for plain-HTTP testing."""
    override = str(os.environ.get("BOOKVOICE_COOKIE_SECURE", "")).strip().lower()
    if override in {"0", "false", "no", "off"}:
        return False
    return True


@router.get("/")
async def read_access(request: Request):
    token = request.cookies.get(access_service.COOKIE_NAME)
    return {
        "authRequired": access_service.auth_required(),
        "authenticated": access_service.is_valid_session(token),
    }


@router.post("/")
async def create_session(login: LoginRequest, request: Request, response: Response):
    if not access_service.auth_required():
        return {"authRequired": False, "authenticated": True}
    # Throttle guessing per client address before touching the password.
    # Behind a proxy every client shares request.client, so prefer the
    # leftmost X-Forwarded-For entry only when proxy headers are trusted.
    client_key = access_service.throttle_key(
        request.client.host if request.client else "unknown",
        request.headers.get("x-forwarded-for", ""),
        trust_proxy_headers=access_service.trust_proxy_headers(),
    )
    blocked = access_service.login_blocked_seconds(client_key)
    if blocked:
        return JSONResponse(
            {
                "detail": {
                    "code": "TOO_MANY_ATTEMPTS",
                    "message": f"Too many attempts. Try again in {blocked}s.",
                }
            },
            status_code=429,
            headers={"Retry-After": str(blocked)},
        )
    if not access_service.verify_password(login.password):
        backoff = access_service.record_login_failure(client_key)
        headers = {"Retry-After": str(backoff)} if backoff else None
        return JSONResponse(
            {"detail": {"code": "INVALID_PASSWORD", "message": "That password is not correct."}},
            status_code=401,
            headers=headers,
        )
    access_service.record_login_success(client_key)
    response.set_cookie(
        access_service.COOKIE_NAME,
        access_service.issue_session(),
        max_age=access_service.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        secure=_secure_cookies(),
        path="/",
    )
    return {"authRequired": True, "authenticated": True}


@router.delete("/")
async def destroy_session(response: Response):
    response.delete_cookie(access_service.COOKIE_NAME, path="/")
    return {"authRequired": access_service.auth_required(), "authenticated": False}

@router.delete("/all")
async def destroy_all_sessions(response: Response):
    """Log out every browser holding a session, including this one."""
    access_service.revoke_all_sessions()
    response.delete_cookie(access_service.COOKIE_NAME, path="/")
    return {"authRequired": access_service.auth_required(), "authenticated": False}
