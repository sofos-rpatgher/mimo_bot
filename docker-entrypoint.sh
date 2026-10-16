#!/bin/sh
# ===========================================================================
# CAs internas de los SAP (contrato MIMO fase 2, C3).
#
# El bot valida el certificado TLS de cada SAP. Los que firma una CA interna
# del cliente (p. ej. *.sap.grupomar.local) sólo validan si esa CA está en el
# almacén de confianza. Chromium en Linux usa la base NSS del usuario
# (~/.pki/nssdb), no el almacén del sistema: cada .crt/.pem que se monte en
# /app/certs se añade ahí al arrancar. Una CA cubre todos los ambientes que
# firme (DEV, QAS, PRD), sin tocar la imagen.
#
#   docker run -v /ruta/a/cas:/app/certs:ro …
# ===========================================================================
set -e

CERT_DIR=/app/certs
NSSDB="sql:$HOME/.pki/nssdb"

found=0
for c in "$CERT_DIR"/*.crt "$CERT_DIR"/*.pem; do
    [ -f "$c" ] || continue
    if [ "$found" = 0 ]; then
        mkdir -p "$HOME/.pki/nssdb"
        [ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "$NSSDB" -N --empty-password
        found=1
    fi
    certutil -d "$NSSDB" -A -t "C,," -n "$(basename "$c")" -i "$c"
    echo "[Entrypoint] CA de confianza añadida: $(basename "$c")"
done

exec "$@"
