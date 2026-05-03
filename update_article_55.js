const fs = require('fs');
const { Blob } = require('buffer');

const BASE_URL = 'http://ipv6.chichu.chat:8088';
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoiQURNSU4iLCJpZCI6MSwiZXhwIjoxNzcyNjQ5NDIwLCJpYXQiOjE3NzIwNDQ2MjAsImp0aSI6IjgwODNhM2ViLWZkMGEtNDgxNi05MDc2LWEwYzcxNWEyNmQ2MCJ9.MvoSCBqtDcwV6xxeckaA6rI7SXc3qQAFJZFVERUB1Hw';

const IMAGE_PATH = 'c:/Users/pw/Desktop/新建文件夹 (3)/F800B1A8683D87A9EB1C8D5E205E4D6F.png';
const ARTICLE_ID = 55;

async function updateArticleCover() {
    try {
        console.log(`[1] 正在读取图片文件: ${IMAGE_PATH}`);
        const imageContent = fs.readFileSync(IMAGE_PATH);

        console.log(`[2] 正在上传图片...`);
        const url = `${BASE_URL}/article/upload/articleCover`;
        const formData = new FormData();
        const blob = new Blob([imageContent], { type: 'image/png' });
        formData.append('articleCover', blob, 'F800B1A8683D87A9EB1C8D5E205E4D6F.png');

        const uploadResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TOKEN}` },
            body: formData
        });

        const uploadResult = await uploadResponse.json();
        if (uploadResult.code !== 200 || !uploadResult.data) {
            console.error('❌ 上传失败，服务器返回:', uploadResult);
            return;
        }

        const newCoverUrl = uploadResult.data;
        console.log(`✅ 上传成功! 新封面URL: ${newCoverUrl}`);

        console.log(`\n[3] 正在获取文章 ${ARTICLE_ID} 的原始数据...`);
        const echoUrl = `${BASE_URL}/article/back/echo/${ARTICLE_ID}`;
        const echoResponse = await fetch(echoUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${TOKEN}` }
        });

        const echoResult = await echoResponse.json();
        if (echoResult.code !== 200 || !echoResult.data) {
            console.error(`❌ 获取文章数据失败，服务器返回:`, echoResult);
            return;
        }

        const articleData = echoResult.data;
        console.log(`📝 成功获取原文数据，标题: ${articleData.articleTitle}`);

        console.log(`\n[4] 正在更新文章封面...`);
        // 修改封面
        articleData.articleCover = newCoverUrl;

        // 发布/更新文章
        const publishUrl = `${BASE_URL}/article/publish`;
        const publishResponse = await fetch(publishUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(articleData)
        });

        const publishResult = await publishResponse.json();
        if (publishResult.code === 200) {
            console.log(`🎉 恭喜！文章 ${ARTICLE_ID} 的封面已成功更新并发布！`);
        } else {
            console.error(`❌ 更新文章失败，服务器返回:`, publishResult);
        }

    } catch (error) {
        console.error('发生异常错误:', error.message);
    }
}

updateArticleCover();
