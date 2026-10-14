<?php

namespace GeneroWP\ReviewComments\Tests\Unit;

use GeneroWP\ReviewComments\Notifications;
use GeneroWP\ReviewComments\Store;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class StoreTest extends TestCase
{
    public static function urls(): array
    {
        return [
            'root' => ['https://example.com/', '/'],
            'trailing slash' => ['/tuote/brace/', '/tuote/brace'],
            'review token' => ['/?review=abc', '/'],
            'tracking' => ['/shop/?utm_source=x&utm_medium=y&gclid=1&fbclid=2', '/shop'],
            'cache buster' => ['/?nocache=1', '/'],
            'meaningful query kept and sorted' => ['/shop?orderby=price&filter_size=2', '/shop?filter_size=2&orderby=price'],
            'mixed' => ['/shop/?utm_campaign=a&orderby=price', '/shop?orderby=price'],
        ];
    }

    #[DataProvider('urls')]
    public function test_normalize_url(string $url, string $expected): void
    {
        $this->assertSame($expected, Store::normalizeUrl($url));
    }

    public function test_device(): void
    {
        $this->assertSame('mobile', Store::device('390x844'));
        $this->assertSame('tablet', Store::device('768x1024'));
        $this->assertSame('desktop', Store::device('1470x733'));
        $this->assertSame('', Store::device(''));
    }

    public function test_chat_webhook_must_be_google_chat(): void
    {
        $this->assertTrue(Notifications::isChatWebhook('https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t'));
        $this->assertFalse(Notifications::isChatWebhook('http://chat.googleapis.com/v1/spaces/AAA/messages'));
        $this->assertFalse(Notifications::isChatWebhook('https://chat.googleapis.com.evil.test/x'));
        $this->assertFalse(Notifications::isChatWebhook('https://example.com/hook'));
    }

    public function test_chat_message(): void
    {
        $thread = ['page_title' => 'Front page', 'url' => '/', 'device' => 'mobile', 'link' => 'https://example.com/#wprc-5'];
        $comment = ['author' => 'Kent', 'text' => 'Logo is blurry'];

        $this->assertSame(
            "*Kent* replied on Front page (mobile):\nLogo is blurry\n<https://example.com/#wprc-5|Open on the site>",
            Notifications::chatMessage($thread, $comment, true)
        );
    }

    public function test_chat_message_cannot_mention_or_link(): void
    {
        $thread = ['page_title' => '<users/all>', 'url' => '/', 'device' => '', 'link' => 'https://example.com/#wprc-5'];
        $comment = ['author' => '*Boss*', 'text' => 'See <https://evil.example|here>'];
        $message = Notifications::chatMessage($thread, $comment, false);

        $this->assertStringNotContainsString('<users/all>', $message);
        $this->assertStringNotContainsString('<https://evil.example', $message);
        $this->assertStringStartsWith('*Boss*', $message);
        $this->assertStringEndsWith('<https://example.com/#wprc-5|Open on the site>', $message);
    }
}
