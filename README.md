## Cloudflare Worker AIS  - Artificial Intelligence Summary


### 部署worker

* [worker.js](worker.js) - worker 代码
* [wrangler.toml](wrangler.toml) - 配置ENV


* ENV VARIABLES

  * OPENAI_API_BASE - The default base URL for OpenAI API requests   `optional`
  * OPENAI_API_KEY - Your OpenAI API key for accessing the language model
  * SUM_MODEL - The model to use for summarization (default: glm-4v-flash)  `optional`




### 放入 HTML 页面

```html

<script src="/web/summarizer.js"
        data-worker="http://localhost/embed/summarizer"
        data-css="/web/summarizer.css"
        data-images="base64"
>
</script>

```

### Demo 

![example.gif](example.gif)