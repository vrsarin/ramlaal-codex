"""Extract only OIDC subject hashes belonging to the authenticated user."""
import re


def oidc_subject_hashes(user):
    subjects = set()
    for credential in user.credentials:
        if credential.auth_provider_type != 'auth_oidc' or credential.auth_provider_id != 'default':
            continue
        subject = credential.data.get('sub')
        if isinstance(subject, str) and re.fullmatch(r'[0-9a-f]{64}', subject):
            subjects.add(subject)
    return sorted(subjects)
