# GitHub Pages 部署与发版

公开仓库 + GitHub Pages 可使用免费托管额度。Pages 只提供静态网页，OCR 从用户浏览器直连其配置的服务商，OCR 费用由用户承担。Pages 有使用限制，商业 SaaS 等用途应另外核对平台条款；自定义域名的注册费另计。

## 首次上线

1. 在自己的 GitHub 账号下创建空的公开仓库（例如 `number-ocr-studio`），不要在线初始化 README。
2. 将本地仓库关联该地址，推送 `main`：
   ```sh
   git remote add origin https://github.com/你的账号/你的仓库.git
   git push -u origin main
   ```
   使用 GitHub Desktop、浏览器登录或 Git 凭证管理器认证；不要把令牌写进远程地址或项目文件。
3. 仓库 Settings → Pages → Source 选择 **GitHub Actions**。
4. 在 Releases → Draft a new release，创建指向 main 的标签 `v1.0.0`，填写说明，发布正式 Release。
5. Actions 中发布成功后，Pages 显示固定网址，通常为 `https://账号.github.io/仓库/`。

工作流仅在正式 Release 发布时上线；main 推送和 PR 只测试和构建，预发布版本不上线。若 GitHub 环境规则阻止标签部署，在 Settings → Environments → github-pages 中允许发布标签。首次上线需完成 Pages 设置，发布成功之前没有公网网址。

## 后续迭代

修改 → `npm test` → `npm run build:pages` → 检查差异 → 提交并推送 main → 创建新正式 Release（`v1.0.1`、`v1.1.0`）。不要修改已发布的标签。

如需回退，优先在 main 中恢复到稳定实现，发布一个新的修复版本；不要依赖删除 Release 自动回滚，删除不会撤下已部署页面。

每个发布构建记录标签及资源内容哈希。站点只上传 dist 里的白名单资源，不上传仓库根目录、server.js、本地配置、测试、文档或截图。构建会检查已知密钥格式、本地密钥副本和专属业务空间地址，发现时终止（这不是完整的秘密扫描器，提交前仍需检查）。

## 用户如何更新

固定网址不变，联网刷新即可读取新版。已打开页面每分钟及回到前台时检查版本，在左侧设置区域显示「有新版本」。点击后提醒用户先完成图片操作，保存输入和输出文本再刷新，不强制打断编辑。

图片选择、当前图片及撤销记录不跨刷新恢复。OCR 设置留在同一个浏览器及域名里，不随 GitHub 发版共享或重置。换设备、域名、浏览器或清除网站数据后需重新配置。

离线时使用缓存版本，下次联网再更新。主屏幕安装版也遵循同样流程。版本检查文件及 OCR 请求不经过离线缓存。

## 密钥和本地开发

- `config.local.json`、`.env*`、dist 等已加入 .gitignore。旧密钥文件保留在本机但新版不读取，不要通过 GitHub Secrets 提供个人 OCR 密钥。
- 浏览器默认会话保存；选择「记住密钥」才会写入本地存储。同一网站的脚本可以访问此存储，因此只在可信设备使用。
- 本地 `npm start` 仅托管网页，所有旧 `/api/` 路由返回 410，不再代访客调用本地密钥。
- 部署不需要设置任何 OCR Secret；用户自己填写 API Key。
- 新网页将不再自动继承本机旧密钥，网站所有者也需要在自己的浏览器设置里手动填写。

参考：[Pages 免费计划与可用性](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)、[Pages 使用限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。
