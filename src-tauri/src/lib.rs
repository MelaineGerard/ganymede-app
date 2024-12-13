use crate::almanax::{AlmanaxApi, AlmanaxApiImpl};
use crate::api::{Api, ApiImpl};
use crate::conf::{ConfApi, ConfApiImpl};
use crate::first_start::FirstStartExt;
use crate::guides::{download_default_guide, GuidesApi, GuidesApiImpl};
use crate::image::{ImageApi, ImageApiImpl};
use crate::security::{SecurityApi, SecurityApiImpl};
use crate::shortcut::handle_shortcuts;
use crate::update::{UpdateApi, UpdateApiImpl};
use log::{error, info, LevelFilter};
use tauri::AppHandle;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;
#[cfg(not(dev))]
use tauri_plugin_sentry::{minidump, sentry};
use taurpc::Router;

mod almanax;
mod api;
mod conf;
mod event;
mod first_start;
mod guides;
mod image;
mod item;
mod json;
mod quest;
mod security;
mod shortcut;
mod tauri_api_ext;
mod update;

#[cfg(debug_assertions)]
const LOG_TARGETS: [Target; 2] = [
    Target::new(TargetKind::Stdout),
    Target::new(TargetKind::Webview),
];

#[cfg(not(debug_assertions))]
const LOG_TARGETS: [Target; 2] = [
    Target::new(TargetKind::Stdout),
    Target::new(TargetKind::LogDir { file_name: None }),
];

#[taurpc::procedures(path = "base", export_to = "../src/ipc/bindings.ts")]
trait BaseApi {
    #[taurpc(alias = "newId")]
    async fn new_id() -> String;
    #[taurpc(alias = "openUrl")]
    async fn open_url(app_handle: AppHandle, url: String) -> Result<(), String>;
}

#[derive(Clone)]
struct BaseApiImpl;

#[taurpc::resolvers]
impl BaseApi for BaseApiImpl {
    async fn new_id(self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    async fn open_url(self, app: AppHandle, url: String) -> Result<(), String> {
        app.opener()
            .open_url(url, None::<String>)
            .map_err(|err| err.to_string())
    }
}

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(dev))]
    let sentry_client = sentry::init((
        env!("SENTRY_DSN"),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            ..Default::default()
        },
    ));

    #[cfg(not(dev))]
    let _guard = minidump::init(&sentry_client);

    let level_filter = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets(LOG_TARGETS)
                .level(level_filter)
                .max_file_size(524_288)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .level_for("tauri", LevelFilter::Info)
                .build(),
        );

    #[cfg(not(dev))]
    let app = app.plugin(tauri_plugin_sentry::init_with_no_injection(&sentry_client));

    let router = Router::new()
        .merge(BaseApiImpl.into_handler())
        .merge(AlmanaxApiImpl.into_handler())
        .merge(GuidesApiImpl.into_handler())
        .merge(ApiImpl.into_handler())
        .merge(SecurityApiImpl.into_handler())
        .merge(ImageApiImpl.into_handler())
        .merge(UpdateApiImpl.into_handler())
        .merge(ConfApiImpl.into_handler());

    app.setup(|app| {
        if let Err(err) = crate::conf::ensure(app.handle()) {
            error!("[Lib] failed to ensure conf: {:?}", err);
        }

        if let Err(err) = crate::guides::ensure(app.handle()) {
            error!("[Lib] failed to ensure guides: {:?}", err);
        }

        let handle = app.handle().clone();

        match handle.is_first_start() {
            Err(err) => {
                error!("[Lib] failed to ensure first start: {:?}", err);
            }
            Ok(first_start) => {
                if first_start {
                    info!("[Lib] first start");

                    tauri::async_runtime::spawn(async move {
                        let res = download_default_guide(&handle).await;

                        match res {
                            Err(err) => {
                                error!("[Lib] cannot download default guide {:?}", err);
                            }
                            Ok(_) => {
                                info!("[Lib] default guide downloaded");
                            }
                        }
                    });
                }
            }
        }

        #[cfg(not(dev))]
        {
            let version = app.package_info().version.to_string();

            tauri::async_runtime::spawn(async {
                let res = api::increment_app_download_count(version).await;

                match &res {
                    Err(err) => {
                        error!("[Lib] {:?}", err);
                    }
                    _ => {
                        info!("[Lib] app download count incremented");
                    }
                }
            });
        }

        #[cfg(desktop)]
        {
            // we do not want to crash the app if some shortcuts are not registered
            if let Err(err) =
                handle_shortcuts(app).map_err(|e| Box::<dyn std::error::Error>::from(e))
            {
                error!("[Lib] failed to handle shortcuts: {:?}", err);
            }
        }

        Ok(())
    })
    .invoke_handler(router.into_handler())
    .run(tauri::generate_context!())
    .expect("[Lib] error while running tauri application");
}
