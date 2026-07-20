use eframe::egui::{
    self, Align2, Color32, FontData, FontDefinitions, FontFamily, FontId, Sense, Vec2,
    ViewportCommand,
};
use eframe::egui::containers::{CentralPanel, Panel};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    Icon, TrayIcon, TrayIconBuilder,
};

const APP_DIR_NAME: &str = "mutishell";
const STATE_FILE_NAME: &str = "state.json";
const DEFAULT_SIDEBAR_WIDTH: f32 = 220.0;
const MIN_SIDEBAR_WIDTH: f32 = 160.0;
const MAX_SIDEBAR_WIDTH: f32 = 360.0;

type AppResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellProfile {
    id: String,
    name: String,
    executable: String,
    args: Vec<String>,
    icon: String,
    detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    created_at: String,
    last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppStateFile {
    version: u32,
    projects: Vec<Project>,
    active_project_id: Option<String>,
    shell_profiles: Vec<ShellProfile>,
    default_shell_profile_id: String,
    #[serde(default = "default_sidebar_width")]
    sidebar_width: f32,
    #[serde(default = "default_theme")]
    theme: String,
}

struct TrayHandle {
    _icon: TrayIcon,
}

struct MutishellApp {
    state: AppStateFile,
    query: String,
    notice: Option<String>,
    settings_open: bool,
    settings_profiles: Vec<ShellProfile>,
    settings_default_profile_id: String,
    dragged_project_id: Option<String>,
    tray: Option<TrayHandle>,
    tray_signature: String,
    minimized_to_tray: bool,
}

impl MutishellApp {
    fn new(creation_context: &eframe::CreationContext<'_>) -> Self {
        install_chinese_font(&creation_context.egui_ctx);
        let (state, notice) = match load_app_state() {
            Ok(state) => (state, None),
            Err(error) => (default_app_state(), Some(format!("加载配置失败：{error}"))),
        };
        apply_theme(&creation_context.egui_ctx, &state.theme);

        let mut app = Self {
            settings_profiles: state.shell_profiles.clone(),
            settings_default_profile_id: state.default_shell_profile_id.clone(),
            state,
            query: String::new(),
            notice,
            settings_open: false,
            dragged_project_id: None,
            tray: None,
            tray_signature: String::new(),
            minimized_to_tray: false,
        };
        app.rebuild_tray();
        app
    }

    fn persist(&mut self) {
        if let Err(error) = save_app_state(&self.state) {
            self.notice = Some(format!("保存配置失败：{error}"));
        }
    }

    fn rebuild_tray(&mut self) {
        let signature = self
            .state
            .projects
            .iter()
            .map(|project| format!("{}:{}:{}", project.id, project.name, project.path))
            .collect::<Vec<_>>()
            .join("|");
        if signature == self.tray_signature && self.tray.is_some() {
            return;
        }

        match build_tray(&self.state.projects) {
            Ok(tray) => {
                self.tray = Some(tray);
                self.tray_signature = signature;
            }
            Err(error) => {
                self.notice = Some(format!("创建托盘图标失败：{error}"));
            }
        }
    }

    fn active_project(&self) -> Option<Project> {
        self.state
            .active_project_id
            .as_ref()
            .and_then(|id| self.state.projects.iter().find(|project| &project.id == id))
            .cloned()
    }

    fn select_project(&mut self, project_id: String) {
        self.state.active_project_id = Some(project_id.clone());
        if let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.last_opened_at = now_string();
        }
        self.persist();
    }

    fn add_project(&mut self) {
        let Some(path) = rfd::FileDialog::new().pick_folder() else {
            return;
        };
        let path = path.to_string_lossy().to_string();
        let path = match normalize_existing_dir(&path) {
            Ok(path) => path,
            Err(error) => {
                self.notice = Some(error);
                return;
            }
        };

        if let Some(existing) = self
            .state
            .projects
            .iter()
            .find(|project| project.path.eq_ignore_ascii_case(&path))
        {
            self.select_project(existing.id.clone());
            return;
        }

        let now = now_string();
        let project = Project {
            id: make_id("project"),
            name: path_base_name(&path),
            path,
            created_at: now.clone(),
            last_opened_at: now,
        };
        self.state.active_project_id = Some(project.id.clone());
        self.state.projects.push(project);
        self.persist();
        self.rebuild_tray();
    }

    fn remove_project(&mut self, project_id: &str) {
        self.state.projects.retain(|project| project.id != project_id);
        if self.state.active_project_id.as_deref() == Some(project_id) {
            self.state.active_project_id = self.state.projects.first().map(|project| project.id.clone());
        }
        self.persist();
        self.rebuild_tray();
    }

    fn reorder_project(&mut self, source_id: &str, target_id: &str, insert_after: bool) -> bool {
        if source_id == target_id {
            return false;
        }
        let Some(source_index) = self
            .state
            .projects
            .iter()
            .position(|project| project.id == source_id)
        else {
            return false;
        };
        let project = self.state.projects.remove(source_index);
        let Some(target_index) = self
            .state
            .projects
            .iter()
            .position(|project| project.id == target_id)
        else {
            self.state.projects.insert(source_index, project);
            return false;
        };
        let insert_index = target_index + usize::from(insert_after);
        self.state.projects.insert(insert_index, project);
        true
    }

    fn launch_profile(&mut self, project: &Project, profile: &ShellProfile) {
        match launch_external_terminal(project, profile) {
            Ok(()) => {
                self.notice = Some(format!("已在 {} 打开 {}", project.name, profile.name));
            }
            Err(error) => {
                self.notice = Some(format!("启动 {} 失败：{error}", profile.name));
            }
        }
    }

    fn launch_default_for_project(&mut self, project_id: &str) {
        let project = self
            .state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned();
        let profile = self
            .state
            .shell_profiles
            .iter()
            .find(|profile| profile.id == self.state.default_shell_profile_id)
            .cloned();
        match (project, profile) {
            (Some(project), Some(profile)) => self.launch_profile(&project, &profile),
            (_, None) => self.notice = Some("未配置默认 Shell。".to_string()),
            (None, _) => self.notice = Some("目录已不存在。".to_string()),
        }
    }

    fn process_tray_events(&mut self, ctx: &egui::Context) {
        while let Ok(event) = MenuEvent::receiver().try_recv() {
            let menu_id = event.id.0.as_str();
            if let Some(project_id) = menu_id.strip_prefix("open-project:") {
                self.launch_default_for_project(project_id);
                continue;
            }
            match menu_id {
                "show-window" => {
                    self.minimized_to_tray = false;
                    ctx.send_viewport_cmd(ViewportCommand::Visible(true));
                    ctx.send_viewport_cmd(ViewportCommand::Minimized(false));
                    ctx.send_viewport_cmd(ViewportCommand::Focus);
                }
                "quit-application" => ctx.send_viewport_cmd(ViewportCommand::Close),
                _ => {}
            }
        }
    }

    fn top_bar(&mut self, root_ui: &mut egui::Ui) {
        Panel::top("top-bar").show(root_ui, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if let Some(project) = self.active_project() {
                    ui.vertical(|ui| {
                        ui.strong(&project.name);
                        ui.label(egui::RichText::new(project.path).small().weak());
                    });
                } else {
                    ui.heading("mutishell");
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let theme_label = if self.state.theme == "dark" {
                        "浅色"
                    } else {
                        "深色"
                    };
                    if ui.button(theme_label).clicked() {
                        self.state.theme = if self.state.theme == "dark" {
                            "light".to_string()
                        } else {
                            "dark".to_string()
                        };
                        apply_theme(ui.ctx(), &self.state.theme);
                        self.persist();
                    }
                    if ui.button("设置").clicked() {
                        self.settings_profiles = self.state.shell_profiles.clone();
                        self.settings_default_profile_id =
                            self.state.default_shell_profile_id.clone();
                        self.settings_open = true;
                    }
                    if let Some(project) = self.active_project() {
                        if ui.button("打开目录").clicked() {
                            if let Err(error) = open_path_in_explorer(&project.path) {
                                self.notice = Some(format!("打开资源管理器失败：{error}"));
                            }
                        }
                    }
                });
            });
            ui.add_space(4.0);
        });
    }

    fn sidebar(&mut self, root_ui: &mut egui::Ui) {
        let projects = self
            .state
            .projects
            .iter()
            .filter(|project| {
                let query = self.query.trim().to_lowercase();
                query.is_empty()
                    || project.name.to_lowercase().contains(&query)
                    || project.path.to_lowercase().contains(&query)
            })
            .cloned()
            .collect::<Vec<_>>();
        let sorting_allowed = self.query.trim().is_empty();
        let panel = Panel::left("projects-sidebar")
            .resizable(true)
            .min_size(MIN_SIDEBAR_WIDTH)
            .max_size(MAX_SIDEBAR_WIDTH)
            .default_size(self.state.sidebar_width)
            .show(root_ui, |ui| {
                ui.horizontal(|ui| {
                    ui.heading("目录");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("+ 添加").clicked() {
                            self.add_project();
                        }
                    });
                });
                ui.add_space(4.0);
                ui.add(
                    egui::TextEdit::singleline(&mut self.query)
                        .hint_text("搜索目录")
                        .desired_width(f32::INFINITY),
                );
                ui.add_space(8.0);
                ui.label(egui::RichText::new("项目").small().weak());
                ui.add_space(2.0);

                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        if projects.is_empty() {
                            let label = if self.state.projects.is_empty() {
                                "还没有项目目录"
                            } else {
                                "没有匹配的目录"
                            };
                            ui.label(egui::RichText::new(label).weak());
                        }
                        for project in &projects {
                            self.project_row(ui, project, sorting_allowed);
                        }
                    });
            });
        let width = panel.response.rect.width();
        if (width - self.state.sidebar_width).abs() > 1.0 {
            self.state.sidebar_width = width.clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
        }
        if root_ui.ctx().input(|input| input.pointer.any_released()) {
            self.dragged_project_id = None;
            self.persist();
            self.rebuild_tray();
        }
    }

    fn project_row(&mut self, ui: &mut egui::Ui, project: &Project, sorting_allowed: bool) {
        let size = Vec2::new(ui.available_width(), 32.0);
        let (rect, response) = ui.allocate_exact_size(size, Sense::click_and_drag());
        let active = self.state.active_project_id.as_deref() == Some(project.id.as_str());
        let dragging = self.dragged_project_id.as_deref() == Some(project.id.as_str());
        let visuals = ui.visuals();
        let background = if active {
            visuals.selection.bg_fill
        } else if response.hovered() {
            visuals.widgets.hovered.bg_fill
        } else {
            Color32::TRANSPARENT
        };
        ui.painter().rect_filled(rect, 6.0, background);
        ui.painter().text(
            rect.left_center() + Vec2::new(8.0, 0.0),
            Align2::LEFT_CENTER,
            "[ ]",
            FontId::proportional(13.0),
            visuals.text_color(),
        );
        ui.painter().text(
            rect.left_center() + Vec2::new(34.0, 0.0),
            Align2::LEFT_CENTER,
            &project.name,
            FontId::proportional(14.0),
            visuals.text_color(),
        );
        if response.hovered() {
            ui.painter().text(
                rect.right_center() - Vec2::new(8.0, 0.0),
                Align2::RIGHT_CENTER,
                if sorting_allowed { "::" } else { "" },
                FontId::monospace(12.0),
                visuals.weak_text_color(),
            );
        }

        if sorting_allowed && response.drag_started() {
            self.dragged_project_id = Some(project.id.clone());
        }
        if sorting_allowed && response.dragged() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
        }
        if sorting_allowed {
            let pointer = ui.ctx().input(|input| {
                input
                    .pointer
                    .interact_pos()
                    .filter(|_| input.pointer.primary_down())
            });
            if let (Some(source_id), Some(pointer)) =
                (self.dragged_project_id.clone(), pointer)
            {
                if source_id != project.id && rect.contains(pointer) {
                    let insert_after = pointer.y > rect.center().y;
                    if self.reorder_project(&source_id, &project.id, insert_after) {
                        self.rebuild_tray();
                    }
                }
            }
        }
        if response.clicked() && !response.dragged() {
            self.select_project(project.id.clone());
        }
        if dragging {
            ui.painter().rect_stroke(
                rect.shrink(1.0),
                6.0,
                egui::Stroke::new(1.0, visuals.selection.stroke.color),
                egui::StrokeKind::Inside,
            );
        }
    }

    fn main_panel(&mut self, root_ui: &mut egui::Ui) {
        CentralPanel::default().show(root_ui, |ui| {
            ui.add_space(12.0);
            let Some(project) = self.active_project() else {
                ui.heading("添加一个项目目录");
                ui.add_space(6.0);
                ui.label("在左侧添加目录，然后在此处快速打开系统终端。");
                ui.add_space(10.0);
                if ui.button("+ 添加目录").clicked() {
                    self.add_project();
                }
                return;
            };

            ui.heading(&project.name);
            ui.label(egui::RichText::new(&project.path).small().weak());
            ui.add_space(12.0);
            ui.separator();
            ui.add_space(8.0);
            ui.label("打开终端");
            ui.add_space(6.0);

            let profiles = self.state.shell_profiles.clone();
            ui.horizontal_wrapped(|ui| {
                for profile in profiles {
                    let label = if profile.id == self.state.default_shell_profile_id {
                        format!("默认：{}", profile.name)
                    } else {
                        profile.name.clone()
                    };
                    let response = ui.add_enabled(profile.detected, egui::Button::new(label));
                    if response.clicked() {
                        self.launch_profile(&project, &profile);
                    }
                }
            });
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("终端将在独立的系统窗口中运行，不由 mutishell 托管。")
                    .small()
                    .weak(),
            );
        });
    }

    fn settings_window(&mut self, ctx: &egui::Context) {
        if !self.settings_open {
            return;
        }
        let mut open = self.settings_open;
        let mut apply = false;
        let mut cancel = false;
        let mut project_to_remove: Option<String> = None;
        egui::Window::new("设置")
            .open(&mut open)
            .default_size(Vec2::new(980.0, 640.0))
            .min_width(760.0)
            .vscroll(true)
            .show(ctx, |ui| {
                ui.label(egui::RichText::new("Shell 配置和项目目录管理").small().weak());
                ui.add_space(8.0);
                ui.columns(2, |columns| {
                    columns[0].heading("Shell Profiles");
                    columns[0].add_space(4.0);
                    for index in 0..self.settings_profiles.len() {
                        let mut profile = self.settings_profiles[index].clone();
                        let profile_id = profile.id.clone();
                        columns[0].group(|ui| {
                            ui.horizontal(|ui| {
                                ui.radio_value(
                                    &mut self.settings_default_profile_id,
                                    profile_id.clone(),
                                    "默认",
                                );
                                ui.strong(&profile.name);
                                let availability = if profile.detected { "可用" } else { "未找到" };
                                let color = if profile.detected {
                                    Color32::from_rgb(55, 178, 105)
                                } else {
                                    Color32::from_rgb(210, 80, 70)
                                };
                                ui.colored_label(color, availability);
                            });
                            ui.add(
                                egui::TextEdit::singleline(&mut profile.executable)
                                    .desired_width(f32::INFINITY),
                            );
                            ui.horizontal(|ui| {
                                if ui.button("检测").clicked() {
                                    profile.detected = executable_exists(&profile.executable);
                                }
                                if ui.button("恢复默认").clicked() {
                                    if let Some(default_profile) = default_shell_profiles()
                                        .into_iter()
                                        .find(|item| item.id == profile.id)
                                    {
                                        profile = default_profile;
                                    }
                                }
                            });
                        });
                        columns[0].add_space(6.0);
                        self.settings_profiles[index] = profile;
                    }

                    columns[1].heading("项目目录");
                    columns[1].add_space(4.0);
                    let projects = self.state.projects.clone();
                    for project in projects {
                        columns[1].group(|ui| {
                            ui.horizontal(|ui| {
                                ui.vertical(|ui| {
                                    ui.strong(&project.name);
                                    ui.label(egui::RichText::new(&project.path).small().weak());
                                });
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        if ui.button("移除").clicked() {
                                            project_to_remove = Some(project.id.clone());
                                        }
                                    },
                                );
                            });
                        });
                        columns[1].add_space(6.0);
                    }
                });
                ui.separator();
                ui.horizontal(|ui| {
                    if ui.button("完成").clicked() {
                        apply = true;
                    }
                    if ui.button("取消").clicked() {
                        cancel = true;
                    }
                });
            });

        if let Some(project_id) = project_to_remove {
            self.remove_project(&project_id);
        }
        if apply {
            for profile in &mut self.settings_profiles {
                profile.executable = profile.executable.trim().to_string();
                profile.detected = executable_exists(&profile.executable);
            }
            self.state.shell_profiles = self.settings_profiles.clone();
            if self
                .state
                .shell_profiles
                .iter()
                .any(|profile| {
                    profile.id == self.settings_default_profile_id && profile.detected
                })
            {
                self.state.default_shell_profile_id =
                    self.settings_default_profile_id.clone();
            } else {
                self.state.default_shell_profile_id =
                    default_shell_id(&self.state.shell_profiles);
            }
            self.persist();
            self.rebuild_tray();
            open = false;
        }
        if cancel {
            open = false;
        }
        self.settings_open = open;
    }

    fn notice_bar(&mut self, root_ui: &mut egui::Ui) {
        let Some(notice) = self.notice.clone() else {
            return;
        };
        Panel::bottom("notice-bar").show(root_ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(notice);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("关闭").clicked() {
                        self.notice = None;
                    }
                });
            });
        });
    }
}

impl eframe::App for MutishellApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.process_tray_events(ctx);
        if ctx.input(|input| input.viewport().minimized == Some(true))
            && !self.minimized_to_tray
        {
            self.minimized_to_tray = true;
            ctx.send_viewport_cmd(ViewportCommand::Visible(false));
        }
        ctx.request_repaint_after(Duration::from_millis(250));
    }

    fn ui(&mut self, root_ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = root_ui.ctx().clone();
        self.top_bar(root_ui);
        self.sidebar(root_ui);
        self.notice_bar(root_ui);
        self.main_panel(root_ui);
        self.settings_window(&ctx);
    }
}

pub fn run() {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1120.0, 720.0])
            .with_min_inner_size([860.0, 560.0]),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "mutishell",
        options,
        Box::new(|creation_context| Ok(Box::new(MutishellApp::new(creation_context)))),
    )
    .expect("failed to run mutishell");
}

fn build_tray(projects: &[Project]) -> AppResult<TrayHandle> {
    let menu = Menu::new();
    if projects.is_empty() {
        let empty = MenuItem::with_id("no-projects", "暂无项目目录", false, None);
        menu.append(&empty)
            .map_err(|error| format!("创建托盘菜单失败：{error}"))?;
    } else {
        for project in projects {
            let item = MenuItem::with_id(
                format!("open-project:{}", project.id),
                &project.name,
                true,
                None,
            );
            menu.append(&item)
                .map_err(|error| format!("创建托盘菜单失败：{error}"))?;
        }
    }
    menu.append(&PredefinedMenuItem::separator())
        .map_err(|error| format!("创建托盘菜单失败：{error}"))?;
    let show = MenuItem::with_id("show-window", "显示 mutishell", true, None);
    let quit = MenuItem::with_id("quit-application", "退出", true, None);
    menu.append(&show)
        .and_then(|_| menu.append(&quit))
        .map_err(|error| format!("创建托盘菜单失败：{error}"))?;

    let icon = make_tray_icon()?;
    let icon = TrayIconBuilder::new()
        .with_tooltip("mutishell")
        .with_icon(icon)
        .with_menu(Box::new(menu))
        .build()
        .map_err(|error| format!("创建托盘图标失败：{error}"))?;
    Ok(TrayHandle { _icon: icon })
}

fn make_tray_icon() -> AppResult<Icon> {
    const SIZE: usize = 32;
    let mut pixels = vec![0_u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let index = (y * SIZE + x) * 4;
            let border = x < 2 || x >= SIZE - 2 || y < 2 || y >= SIZE - 2;
            let prompt = (x >= 8 && x <= 12 && y >= 9 && y <= 13)
                || (x >= 12 && x <= 16 && y >= 13 && y <= 17)
                || (x >= 18 && x <= 24 && y >= 21 && y <= 23);
            let (red, green, blue) = if border {
                (72, 163, 184)
            } else if prompt {
                (238, 247, 249)
            } else {
                (23, 37, 47)
            };
            pixels[index] = red;
            pixels[index + 1] = green;
            pixels[index + 2] = blue;
            pixels[index + 3] = 255;
        }
    }
    Icon::from_rgba(pixels, SIZE as u32, SIZE as u32)
        .map_err(|error| format!("生成托盘图标失败：{error}"))
}

fn load_app_state() -> AppResult<AppStateFile> {
    let path = state_file_path()?;
    if !path.exists() {
        return Ok(default_app_state());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("读取配置失败 '{}': {error}", path.display()))?;
    let mut state: AppStateFile = serde_json::from_str(&content)
        .map_err(|error| format!("解析配置失败 '{}': {error}", path.display()))?;
    reconcile_profiles(&mut state);
    if !state
        .active_project_id
        .as_ref()
        .is_some_and(|id| state.projects.iter().any(|project| &project.id == id))
    {
        state.active_project_id = state.projects.first().map(|project| project.id.clone());
    }
    state.version = 2;
    Ok(state)
}

fn save_app_state(state: &AppStateFile) -> AppResult<()> {
    let path = state_file_path()?;
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建配置目录失败 '{}': {error}", parent.display()))?;
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| format!("序列化配置失败：{error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("写入配置失败 '{}': {error}", path.display()))
}

fn default_app_state() -> AppStateFile {
    let shell_profiles = default_shell_profiles();
    AppStateFile {
        version: 2,
        projects: Vec::new(),
        active_project_id: None,
        default_shell_profile_id: default_shell_id(&shell_profiles),
        shell_profiles,
        sidebar_width: DEFAULT_SIDEBAR_WIDTH,
        theme: default_theme(),
    }
}

fn reconcile_profiles(state: &mut AppStateFile) {
    let detected_profiles = default_shell_profiles();
    for profile in &mut state.shell_profiles {
        if profile.executable.trim().is_empty() {
            if let Some(default_profile) = detected_profiles
                .iter()
                .find(|default_profile| default_profile.id == profile.id)
            {
                profile.executable = default_profile.executable.clone();
            }
        }
        profile.detected = executable_exists(&profile.executable);
    }
    for profile in detected_profiles {
        if !state
            .shell_profiles
            .iter()
            .any(|existing| existing.id == profile.id)
        {
            state.shell_profiles.push(profile);
        }
    }
    if !state
        .shell_profiles
        .iter()
        .any(|profile| profile.id == state.default_shell_profile_id && profile.detected)
    {
        state.default_shell_profile_id = default_shell_id(&state.shell_profiles);
    }
    state.sidebar_width = state
        .sidebar_width
        .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    if state.theme != "light" {
        state.theme = "dark".to_string();
    }
}

fn default_sidebar_width() -> f32 {
    DEFAULT_SIDEBAR_WIDTH
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_shell_profiles() -> Vec<ShellProfile> {
    let mut profiles = vec![
        ShellProfile {
            id: "powershell".to_string(),
            name: "Windows PowerShell".to_string(),
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string()],
            icon: "powershell".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "pwsh".to_string(),
            name: "PowerShell 7".to_string(),
            executable: find_first_existing(&[
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                "C:\\Program Files\\PowerShell\\6\\pwsh.exe",
            ])
            .unwrap_or_else(|| "pwsh.exe".to_string()),
            args: vec!["-NoLogo".to_string()],
            icon: "pwsh".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            executable: "C:\\Windows\\System32\\cmd.exe".to_string(),
            args: Vec::new(),
            icon: "cmd".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "git-bash".to_string(),
            name: "Git Bash".to_string(),
            executable: find_first_existing(&[
                "C:\\Program Files\\Git\\git-bash.exe",
                "C:\\Program Files (x86)\\Git\\git-bash.exe",
                "D:\\soft\\Git\\git-bash.exe",
                "D:\\Git\\git-bash.exe",
            ])
            .unwrap_or_else(|| "C:\\Program Files\\Git\\git-bash.exe".to_string()),
            args: Vec::new(),
            icon: "git-bash".to_string(),
            detected: false,
        },
        ShellProfile {
            id: "wsl".to_string(),
            name: "WSL".to_string(),
            executable: "C:\\Windows\\System32\\wsl.exe".to_string(),
            args: Vec::new(),
            icon: "wsl".to_string(),
            detected: false,
        },
    ];
    for profile in &mut profiles {
        profile.detected = executable_exists(&profile.executable);
    }
    profiles
}

fn default_shell_id(profiles: &[ShellProfile]) -> String {
    profiles
        .iter()
        .find(|profile| profile.id == "pwsh" && profile.detected)
        .or_else(|| profiles.iter().find(|profile| profile.id == "powershell" && profile.detected))
        .or_else(|| profiles.iter().find(|profile| profile.detected))
        .map(|profile| profile.id.clone())
        .unwrap_or_else(|| "powershell".to_string())
}

fn launch_external_terminal(project: &Project, profile: &ShellProfile) -> AppResult<()> {
    let cwd = normalize_existing_dir(&project.path)?;
    let executable = clean_executable_path(&profile.executable);
    if !executable_exists(&executable) {
        return Err(format!("未找到可执行文件 '{}'", profile.executable));
    }
    let mut command = Command::new(&executable);
    command.args(&profile.args).current_dir(cwd);
    configure_external_terminal_command(&mut command);
    command
        .spawn()
        .map_err(|error| format!("无法启动 {}：{error}", profile.name))?;
    Ok(())
}

fn open_path_in_explorer(path: &str) -> AppResult<()> {
    let path = normalize_existing_dir(path)?;
    Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    Ok(())
}

#[cfg(windows)]
fn configure_external_terminal_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(0x0000_0010);
}

#[cfg(not(windows))]
fn configure_external_terminal_command(_command: &mut Command) {}

fn state_file_path() -> AppResult<PathBuf> {
    let base_dir = dirs::config_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "无法定位用户配置目录".to_string())?;
    Ok(base_dir.join(APP_DIR_NAME).join(STATE_FILE_NAME))
}

fn normalize_existing_dir(path: &str) -> AppResult<String> {
    let input = expand_home(path);
    let input_path = PathBuf::from(input);
    let canonical = fs::canonicalize(&input_path)
        .map_err(|error| format!("目录 '{}' 不存在：{error}", input_path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("'{}' 不是目录", canonical.display()));
    }
    Ok(clean_windows_path(&canonical.to_string_lossy()))
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

fn clean_executable_path(path: &str) -> String {
    clean_windows_path(path.trim().trim_matches('"'))
}

fn clean_windows_path(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{stripped}");
    }
    if let Some(stripped) = path.strip_prefix(r"\\?\") {
        return stripped.to_string();
    }
    path.to_string()
}

fn executable_exists(executable: &str) -> bool {
    let executable = clean_executable_path(executable);
    if executable.is_empty() {
        return false;
    }
    if Path::new(&executable).exists() {
        return true;
    }
    let Ok(path_env) = std::env::var("PATH") else {
        return false;
    };
    let executable_path = Path::new(&executable);
    let candidates = if executable_path.extension().is_some() {
        vec![executable]
    } else {
        vec![format!("{executable}.exe"), executable]
    };
    std::env::split_paths(&path_env)
        .any(|directory| candidates.iter().any(|candidate| directory.join(candidate).exists()))
}

fn find_first_existing(paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .find(|path| Path::new(path).exists())
        .map(|path| (*path).to_string())
}

fn path_base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn make_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{prefix}-{nanos}")
}

fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn install_chinese_font(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    for path in [
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\msyhbd.ttc",
        "C:\\Windows\\Fonts\\simhei.ttf",
    ] {
        if let Ok(bytes) = fs::read(path) {
            fonts
                .font_data
                .insert("windows-cjk".to_string(), FontData::from_owned(bytes).into());
            fonts
                .families
                .entry(FontFamily::Proportional)
                .or_default()
                .insert(0, "windows-cjk".to_string());
            fonts
                .families
                .entry(FontFamily::Monospace)
                .or_default()
                .push("windows-cjk".to_string());
            break;
        }
    }
    ctx.set_fonts(fonts);
}

fn apply_theme(ctx: &egui::Context, theme: &str) {
    let mut visuals = if theme == "light" {
        egui::Visuals::light()
    } else {
        egui::Visuals::dark()
    };
    visuals.selection.bg_fill = Color32::from_rgb(56, 113, 130);
    visuals.selection.stroke.color = Color32::from_rgb(98, 183, 202);
    ctx.set_visuals(visuals);
}
