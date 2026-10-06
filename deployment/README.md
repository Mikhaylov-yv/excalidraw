# CI/CD и деплой на staging (GitLab)

Пайплайн описан в [`.gitlab-ci.yml`](../.gitlab-ci.yml), стадии `lint → test → build → deploy`. Образец — `doc_ocr`, правила — FESCO-rules-development (`docs/upload/ci-cd`).

Окружение одно — **staging**: расходуемое превью, выкатывается кнопкой с любой ветки. dev- и prod-стендов нет.

Что именно разворачивается и как устроен сервер — в [`selfhost/README.md`](../selfhost/README.md).

## Что отличается от образца

- **Два образа**: `app` (`selfhost/app.Dockerfile`) и `server` (`selfhost/server/Dockerfile`), лежат в `$CI_REGISTRY_IMAGE/app` и `$CI_REGISTRY_IMAGE/server`.
- **Версия берётся из `selfhost/server/package.json`** — у монорепозитория Excalidraw своей версии приложения нет.
- **Своего состояния у стенда нет**: томов в compose нет, данные лежат в существующем RustFS контура.
- **`VITE_*` одинаковы для всех окружений** (вариант «Единые `VITE_*`» из правил): адреса сервера относительные и зашиты в `selfhost/app.Dockerfile`, образ `app` от окружения не зависит.
- **Тесты редактора не гоняются**: из ~2500 тестов upstream запускаются только тесты `excalidraw-app/` — там всё, что форк меняет во фронтенде.

## Джобы

| Джоба | Стадия | Когда | Что делает |
| --- | --- | --- | --- |
| `lint` | lint | любой push и MR | `yarn test:other` (prettier), `yarn test:code` (eslint), `yarn test:typecheck` (tsc) — как в upstream |
| `test-app` | test | любой push и MR | тесты `excalidraw-app/`, включая хранилище по HTTP |
| `test-server` | test | любой push и MR | `npm ci`, проверка типов и тесты сервера; в сеть и к S3 тесты не ходят |
| `build-staging` | build | **кнопка**, любая ветка | собирает оба образа, пушит `staging-latest` и `{version}-{pipeline}` |
| `deploy-staging` | deploy | сам, после `build-staging` | `docker compose pull` + `up -d --wait` на VM по SSH |

`build-staging` не ждёт lint и test (`needs: []`): превью катится и при красных тестах.

Все джобы идут по одной (общая `resource_group`): раннер выкачивает исходники разных джоб в один каталог, и две джобы разом ломают друг другу `git checkout` (`Unable to create '.git/index.lock'`).

## Как выкатить

1. GitLab → Build → Pipelines → пайплайн нужной ветки.
2. Нажать ▶ у `build-staging`. `deploy-staging` запустится сам.
3. Стенд: `http://<STAGING_VM_HOST>:<EXCALIDRAW_PORT>` — но см. раздел про HTTPS ниже.

Деплой пересоздаёт контейнеры: открытые комнаты на несколько секунд теряют связь и переподключаются сами. Данные лежат в S3 и деплой переживают.

## HTTPS обязателен

Приложение шифрует схемы в браузере через WebCrypto, а браузеры дают этот API только по HTTPS (или на `localhost`). По адресу `http://<VM>:<порт>` рисовать можно, но **комнаты и ссылки-копии работать не будут**.

Стенд отдаёт HTTP. TLS даёт nginx контура, который ставится поверх сервиса отдельно, вне этого репозитория. От него нужны проксирование на `<STAGING_VM_HOST>:<EXCALIDRAW_PORT>` и проброс WebSocket:

```nginx
location / {
    proxy_pass http://STAGING_VM_HOST:EXCALIDRAW_PORT;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
    client_max_body_size 64m;
}
```

## Переменные GitLab (Settings → CI/CD → Variables)

| Переменная | Тип | Назначение |
| --- | --- | --- |
| `ENV_CONTAINER_EXCALIDRAW_STAGING` | **File** | `.env` стенда — все настройки окружения в одном файле |
| `STAGING_SSH_KEY` | **File** | приватный SSH-ключ деплоера; публичный — в `authorized_keys` на VM |
| `STAGING_VM_HOST` | Variable | хост или IP VM staging |
| `STAGING_SSH_USER` | Variable | пользователь-деплоер на VM, в группе `docker` |

`STAGING_*` называются так же, как в `doc_ocr` и `sd_classification`: если они заведены на уровне группы, проекту достаточно одной своей переменной — `ENV_CONTAINER_EXCALIDRAW_STAGING`.

В реестр образов джобы входят учётными данными, которые GitLab сам выдаёт каждой джобе (`CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD`), — заводить для этого ничего не нужно. Проект должен лежать в группе: образы `docker` и `node` для джоб берутся через её Dependency Proxy.

### Содержимое `ENV_CONTAINER_EXCALIDRAW_STAGING`

Пример — [`.env.staging.example`](.env.staging.example).

| Ключ | Кто читает | Что это |
| --- | --- | --- |
| `EXCALIDRAW_PORT` | compose | порт стенда на VM |
| `S3_ENDPOINT` | контейнер `server` | адрес S3 API существующего RustFS, как он виден с VM |
| `S3_REGION` | контейнер `server` | регион; для RustFS подходит `us-east-1` |
| `S3_BUCKET` | контейнер `server` | бакет стенда |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | контейнер `server` | ключи доступа к бакету |
| `S3_FORCE_PATH_STYLE` | контейнер `server` | `true` для RustFS и MinIO |

### Подключение к RustFS

- Ключу нужны чтение и запись объектов в бакете (`s3:GetObject`, `s3:PutObject`) и `s3:ListBucket` — им сервер проверяет бакет при старте.
- Бакет заводится заранее. Если его нет, сервер попробует создать его при старте — на это ключу нужно право на создание бакета.
- Сервер проверяет бакет до того, как начать слушать порт. Неверный адрес или ключи — контейнер не поднимается, `deploy-staging` падает на `up --wait`, причина — в логе контейнера `excalidraw-staging-server` (`Cannot access the S3 bucket …`).
- В бакете появятся префиксы `rooms/`, `shareLinks/` и `files/`. Содержимое объектов зашифровано ключами из ссылок, сервер и RustFS его прочитать не могут.

## Что должно быть на VM

- Docker с плагином compose; деплоер в группе `docker`.
- SSH-доступ с раннера по ключу. Последняя строка ключа в File-переменной должна заканчиваться переводом строки, иначе ssh ключ не примет.
- Свободный порт `EXCALIDRAW_PORT`, доступный nginx контура.
- Доступ с VM к реестру образов GitLab и к RustFS по `S3_ENDPOINT`.

Стенд на VM — compose-проект `excalidraw-staging`: контейнеры `excalidraw-staging-app` и `excalidraw-staging-server`, томов нет.

## Что нужно сборке и джобам от сети

`docker build` на раннере ходит наружу за тремя вещами:

- Docker Hub — `node:24`, `node:22-alpine`, `nginx:stable-alpine-slim`;
- `registry.yarnpkg.com` — зависимости приложения из `yarn.lock`;
- `registry.npmjs.org` — зависимости сервера из `package-lock.json`.

Джобы `lint`, `test-app` и `test-server` ходят в те же два реестра пакетов.

## Что приложение запрашивает снаружи из браузера

Сборка upstream зашивает в страницу два внешних адреса, env-переменными они не отключаются:

- `excalidraw.nyc3.cdn.digitaloceanspaces.com` — шрифты (есть локальный запасной путь);
- `scripts.simpleanalyticscdn.com` — скрипт аналитики.

Если с рабочих мест эти адреса недоступны, приложение работает, но первая загрузка идёт дольше, а интерфейс рисуется системным шрифтом. Данные схем туда не уходят.
