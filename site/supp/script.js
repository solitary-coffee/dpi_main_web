document.addEventListener('DOMContentLoaded', function() {
    
    // --- ① メニュー開閉機能 ---
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.overlay');

    if (menuToggleBtn && sidebar && overlay) {
        menuToggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('open');
        });

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('open');
        });
    }

    // --- ② スライドショー機能 ---
    const slides = document.querySelector('.slides');
    if (slides) {
        const images = document.querySelectorAll('.slides img');
        const prevBtn = document.querySelector('.prev-btn');
        const nextBtn = document.querySelector('.next-btn');

        if (images.length > 0) {
            let currentIndex = 0;
            const totalImages = images.length;

            function goToSlide(index) {
                if (index < 0) {
                    index = totalImages - 1;
                } else if (index >= totalImages) {
                    index = 0;
                }
                slides.style.transform = `translateX(-${index * 100}%)`;
                currentIndex = index;
            }

            nextBtn.addEventListener('click', () => {
                goToSlide(currentIndex + 1);
            });

            prevBtn.addEventListener('click', () => {
                goToSlide(currentIndex - 1);
            });
        }
    }

    // --- ③ アコーディオン機能 ---
    const commandTriggers = document.querySelectorAll('.command-trigger');

    commandTriggers.forEach(trigger => {
        trigger.addEventListener('click', function() {
            this.classList.toggle('active');
            const content = this.nextElementSibling;

            if (content.style.maxHeight) {
                content.style.maxHeight = null;
            } else {
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    });

}); 