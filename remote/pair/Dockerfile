FROM python:3.12-alpine
RUN apk add --no-cache openssl
COPY app.py /app/app.py
# Named volumes start out with these owners, so the service can write without root.
RUN mkdir -p /data /pki && chown 1000:1000 /data /pki
USER 1000:1000
EXPOSE 8095
CMD ["python", "-u", "/app/app.py"]
