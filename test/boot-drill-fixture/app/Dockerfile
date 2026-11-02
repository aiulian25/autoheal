FROM docker:29.9.0-cli
ARG FORMAT=1
ENV WANT_FORMAT=$FORMAT
COPY app.sh /app.sh
ENTRYPOINT ["/bin/sh", "/app.sh"]
CMD []
