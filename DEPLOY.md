# Cloudflare 网页后台部署教程

## 适用范围

这份教程只讲：

- 用 Cloudflare 网页后台创建 D1 数据库
- 绑定到 Worker
- 初始化数据库表
- 粘贴代码并发布

不包含命令行 `wrangler` 部署流程。

## 需要准备的文件

项目里会用到这些文件：

- [email-temp-inbox.js](/C:/Users/Administrator/Documents/HBuilderProjects/Email/email-temp-inbox.js)
- [wrangler.toml](/C:/Users/Administrator/Documents/HBuilderProjects/Email/wrangler.toml)
- [migrations/0001_init.sql](/C:/Users/Administrator/Documents/HBuilderProjects/Email/migrations/0001_init.sql)
- [migrations/0002_add_html_content.sql](/C:/Users/Administrator/Documents/HBuilderProjects/Email/migrations/0002_add_html_content.sql)
- [migrations/INIT_ALL.sql](/C:/Users/Administrator/Documents/HBuilderProjects/Email/migrations/INIT_ALL.sql)

网页后台部署时，主要会复制：

- `email-temp-inbox.js` 的完整代码
- `INIT_ALL.sql`

## 第一步：创建 D1 数据库

1. 登录 Cloudflare
2. 打开左侧 `Workers & Pages`
3. 进入 `D1`
4. 点击 `Create database`
5. 数据库名称填写：`email-temp-inbox`
6. 创建完成

## 第二步：给 Worker 绑定 D1

1. 回到 `Workers & Pages`
2. 打开你正在使用的 Worker
3. 找到 `Settings` 或 `Bindings`
4. 添加一个 `D1 binding`
5. 绑定名填写：`DB`
6. 数据库选择刚创建的 `email-temp-inbox`
7. 保存

绑定名必须是 `DB`，因为代码里就是按这个名字读取数据库。

## 第三步：初始化数据库表结构

1. 打开你刚创建的 D1 数据库
2. 进入 `Console`
3. 把 [INIT_ALL.sql](/C:/Users/Administrator/Documents/HBuilderProjects/Email/migrations/INIT_ALL.sql) 的内容全部复制进去
4. 点击执行

这个文件已经把：

- `0001_init.sql`
- `0002_add_html_content.sql`

按正确顺序合并好了，适合网页后台一次性初始化空数据库。

## 第四步：更新 Worker 代码

1. 打开 Worker 编辑页
2. 找到主入口脚本
3. 用 [email-temp-inbox.js](/C:/Users/Administrator/Documents/HBuilderProjects/Email/email-temp-inbox.js) 的完整内容替换现有代码
4. 保存

## 第五步：发布

1. 点击 `Deploy`
2. 等待发布完成
3. 打开你的正式域名检查页面是否正常

## 后续更新怎么做

如果只是改页面或 Worker 逻辑：

1. 打开 Worker 编辑页
2. 替换 `email-temp-inbox.js`
3. 点击 `Deploy`

如果以后新增了新的 SQL 迁移文件：

1. 先去 D1 `Console` 执行新的 SQL
2. 再回 Worker 页面发布新代码

## 这两个 SQL 文件要不要保留

要保留：

- `0001_init.sql`
- `0002_add_html_content.sql`
- `INIT_ALL.sql`

原因：

- 新建数据库时可以直接执行 `INIT_ALL.sql`
- 以后别人接手部署时也要用
- `0001` 和 `0002` 仍然是正式拆分步骤

## 当前目录建议保留的文件

- `email-temp-inbox.js`
- `wrangler.toml`
- `migrations/`
- `.gitignore`
- `DEPLOY.md`

## 当前目录不建议保留的内容

- `.wrangler/`
- `node_modules/`
- 本地缓存文件
