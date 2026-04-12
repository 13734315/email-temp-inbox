前提域名已接入Cloudflare，并开启电子邮件路由

第一步，新建Worker
复制email-temp-inbox.js里的全部代码到Worker

第二步，设置邮箱路由
Cloudflare邮箱路由转发到新建的Worker

<img width="458" height="393" alt="image" src="https://github.com/user-attachments/assets/42dc8961-2dcb-459a-8d84-b637c93bf8ab" />

第三步，连接数据库

在Worker项目里选择绑定-添加绑定-D1数据库

变量名称输入：DB

D1 数据库输入：email-temp-inbox


<img width="568" height="359" alt="image" src="https://github.com/user-attachments/assets/e97dcbfb-4cf8-4f31-b567-7799b0f4a7f8" />


第四步，数据库设置
进入到D1数据库-点击控制台，
复制migrations/INIT_ALL.sql 里的全部内容-点执行。

最后，点击Worker项目地址即可使用，最后设置Worker自定义域名。






