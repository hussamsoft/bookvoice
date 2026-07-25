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
async def create_session(request: LoginRequest, response: Response):
    if not access_service.auth_required():
        return {"authRequired": False, "authenticated": True}
    if not access_service.verify_password(request.password):
        return JSONResponse(
            {"detail": {"code": "INVALID_PASSWORD", "message": "That password is not correct."}},
            status_code=401,
        )
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
