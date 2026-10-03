FROM python:3.12-alpine
RUN apk add --no-cache ffmpeg
COPY app.py /app/app.py
USER 1000:1000
EXPOSE 8097
CMD ["python", "-u", "/app/app.py"]
